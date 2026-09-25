package com.yunpan.mobile;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.Dialog;
import android.app.DownloadManager;
import android.content.Context;
import android.content.ClipData;
import android.content.Intent;
import android.content.SharedPreferences;
import android.database.Cursor;
import android.graphics.Bitmap;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.provider.OpenableColumns;
import android.util.Log;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.webkit.CookieManager;
import android.webkit.DownloadListener;
import android.webkit.JavascriptInterface;
import android.webkit.MimeTypeMap;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;
import android.graphics.Color;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.zip.GZIPInputStream;

/**
 * 123云盘移动端 (复刻 123pan-open 的 API 客户端能力)
 *
 * 架构：
 *  - 原生网络层 HttpURLConnection 调用 123 云盘 API（复刻 123pan-open 端点）
 *  - 通过 JS 桥 NativeBridge 暴露给内嵌移动端 SPA（assets/index.html）
 *  - token 持久化到 SharedPreferences
 */
public class MainActivity extends Activity {

    private WebView webView;
    private final Handler handler = new Handler(Looper.getMainLooper());
    // 并发工作线程数：全盘查重会同时发起大量 file/list 请求（每个子目录 1 个），
    // 线程过少会导致大量请求排队、甚至在 20s readTimeout 下超时，从而“部分目录静默丢失”
    // （表现为两次扫描文件数不一致）。提升到 12 以覆盖递归遍历的并发峰值。
    private final ExecutorService executor = Executors.newFixedThreadPool(12);
    private SharedPreferences prefs;
    private String downloadSubDir = "123云盘";

    private static final String PREF = "pan_prefs";
    private static final String KEY_TOKEN = "token";
    private static final String KEY_USER = "user";
    private static final String KEY_PASS = "pass";
    private static final String KEY_DEVICE = "deviceType";

    private ValueCallback<Uri[]> uploadMessage;
    private static final int FILE_CHOOSER_REQUEST = 1001;
    private static final int FOLDER_PICK_REQUEST = 1002;
    private static final int DOWNLOAD_DIR_PICK_REQUEST = 1003;

    private String loginuuid = UUID.randomUUID().toString().replace("-", "");
    private String deviceType = "X12";
    private String osVersion = "13";
    private String devicename = "Xiaomi";

    // 自研流式下载任务表：taskId -> DlTask（支持暂停/继续/重试/断点续传）
    private final java.util.Map<Long, DlTask> dlTasks =
        new java.util.concurrent.ConcurrentHashMap<>();
    // stream 任务成功落盘后的文件绝对路径：taskId -> path（供 openDownloadedFile 定位）
    private final java.util.Map<Long, String> streamTaskFiles =
        new java.util.concurrent.ConcurrentHashMap<>();
    // stream 任务成功后的 MediaStore content URI：taskId -> content://media/external/downloads/<id>
    // （打开/安装优先用它，避免 PanProvider path 解析问题导致安装器读到损坏内容）
    private final java.util.Map<Long, String> streamTaskUris =
        new java.util.concurrent.ConcurrentHashMap<>();
    private long nextTaskId = 900000000L;
    // 上传任务表：taskId -> UpTask（支持取消 / 队列管理）。任务 id 区间 800000000+，与下载任务（900000000+）区分
    private final java.util.Map<Long, UpTask> upTasks =
        new java.util.concurrent.ConcurrentHashMap<>();
    private long nextUpId = 800000000L;
    // 大文件分片上传阈值：>=5MB 走 multipart（服务端 SliceSize 默认 5MB）；<5MB 维持整对象直传
    private static final long UPLOAD_SLICE_THRESHOLD = 5L * 1024 * 1024;
    // 分片上传"未开始传输数据前"失败时，允许回退整对象直传的最大文件（避免中等文件因分片初始化故障无法上传）
    private static final long UPLOAD_FALLBACK_MAX = 64L * 1024 * 1024;
    private String baseHeaders =
        "platform=android;app-version=61;x-app-version=2.4.0;user-agent=123pan/v2.4.0("
        + osVersion + ";Xiaomi)";

    // ---- 官方登录（主 WebView 直接加载官方登录页） ----
    private boolean officialLoginDone = false; // 已捕获到 sso-token（避免重复回填）
    private boolean verifyMode = false; // 安全验证模式（在验证页面按返回键回App）
    private static final String OFFICIAL_LOGIN_URL =
        "https://user.123pan.cn/centerlogin?redirect_url=https%3A%2F%2Fyun.123pan.cn%2F&source_page=website";

    // 系统是否为深色模式
    public boolean isSystemDark() {
        try {
            int nightMode = getResources().getConfiguration().uiMode
                & android.content.res.Configuration.UI_MODE_NIGHT_MASK;
            return nightMode == android.content.res.Configuration.UI_MODE_NIGHT_YES;
        } catch (Exception e) { return false; }
    }

    // ---- 屏幕常亮 ----
    private android.os.PowerManager.WakeLock wakeLock;
    public void setKeepScreenOn(boolean on) {
        runOnUiThread(() -> {
            if (on) {
                getWindow().addFlags(android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                if (wakeLock == null) {
                    android.os.PowerManager pm = (android.os.PowerManager) getSystemService(POWER_SERVICE);
                    wakeLock = pm.newWakeLock(android.os.PowerManager.SCREEN_BRIGHT_WAKE_LOCK | android.os.PowerManager.ACQUIRE_CAUSES_WAKEUP, "pan:keep");
                    wakeLock.setReferenceCounted(false);
                }
                if (!wakeLock.isHeld()) wakeLock.acquire();
            } else {
                getWindow().clearFlags(android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
            }
        });
    }

    // ---- 自定义下载目录 ----
    public String getDownloadSubDir() {
        return downloadSubDir == null ? "123云盘" : downloadSubDir;
    }

    public void setDownloadSubDir(String dir) {
        if (dir == null) dir = "123云盘";
        dir = dir.trim();
        if (dir.isEmpty()) dir = "123云盘";
        downloadSubDir = dir;
        if (prefs != null) {
            prefs.edit().putString("download_sub_dir", dir).apply();
        }
    }

    // MediaStore 相对路径，如 "Download/123云盘"
    public String downloadRelPath() {
        return Environment.DIRECTORY_DOWNLOADS + "/" + getDownloadSubDir();
    }

    // 删除已下载的文件（文件系统 + MediaStore 记录）
    public void deleteDownloadedFile(String fileName) {
        if (fileName == null || fileName.isEmpty()) return;
        // 1) 删文件系统
        try {
            // 新目录
            File dir = Environment.getExternalStoragePublicDirectory(downloadRelPath());
            File f = new File(dir, fileName);
            if (f.exists()) f.delete();
            // 兼容旧默认目录 Download/ 根目录
            File oldDir = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS);
            File f2 = new File(oldDir, fileName);
            if (f2.exists()) f2.delete();
        } catch (Exception ignore) {}
        // 2) 删 MediaStore 记录
        try {
            android.content.ContentResolver cr = getContentResolver();
            Uri uri = android.provider.MediaStore.Downloads.EXTERNAL_CONTENT_URI;
            String[] sel = new String[] { fileName };
            cr.delete(uri, android.provider.MediaStore.MediaColumns.DISPLAY_NAME + "=?", sel);
        } catch (Exception ignore) {}
    }

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().setFlags(
            android.view.WindowManager.LayoutParams.FLAG_HARDWARE_ACCELERATED,
            android.view.WindowManager.LayoutParams.FLAG_HARDWARE_ACCELERATED);
        webView = new WebView(this);
        setContentView(webView);
        prefs = getSharedPreferences(PREF, Context.MODE_PRIVATE);
        downloadSubDir = prefs.getString("download_sub_dir", "123云盘");
        loginuuid = prefs.getString("loginuuid", loginuuid);

        WebSettings ws = webView.getSettings();
        ws.setJavaScriptEnabled(true);
        ws.setDomStorageEnabled(true);
        ws.setDatabaseEnabled(true);
        ws.setAllowFileAccess(true);
        ws.setAllowContentAccess(true);
        // file:// 页面允许跨源访问（本地预览代理 http://127.0.0.1 需要）
        ws.setAllowUniversalAccessFromFileURLs(true);
        ws.setUseWideViewPort(true);
        ws.setLoadWithOverviewMode(true);
        ws.setSupportZoom(false);
        ws.setBuiltInZoomControls(true);
        ws.setDisplayZoomControls(false);
        ws.setCacheMode(WebSettings.LOAD_NO_CACHE);

        webView.addJavascriptInterface(new NativeBridge(this), "NativeBridge");

        // 文件选择（<input type=file> 上传）支持
        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView wv, ValueCallback<Uri[]> filePathCallback,
                                             FileChooserParams fileChooserParams) {
                // 若已有未完成回调，先取消，避免 UI 卡死
                if (uploadMessage != null) { uploadMessage.onReceiveValue(null); }
                uploadMessage = filePathCallback;
                Intent intent = fileChooserParams.createIntent();
                if (fileChooserParams.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE) {
                    intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
                }
                try {
                    startActivityForResult(intent, FILE_CHOOSER_REQUEST);
                } catch (Exception e) {
                    uploadMessage = null;
                    toast("无法打开文件选择器");
                    return false;
                }
                return true;
            }
        });

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, String url) {
                // 拦截 thumb://fileId=xxx 返回 123pan 缩略图
                if (url != null && url.startsWith("thumb://")) {
                    try {
                        String fid = url.substring("thumb://fileId=".length());
                        String token = prefs.getString(KEY_TOKEN, "");
                        java.net.HttpURLConnection c = (java.net.HttpURLConnection)
                            new java.net.URL("https://www.123pan.cn/api/file/thumbnail?fileId=" + fid).openConnection();
                        c.setConnectTimeout(8000);
                        c.setReadTimeout(8000);
                        c.setRequestProperty("authorization", "Bearer " + token);
                        c.setRequestProperty("platform", "web");
                        c.setRequestProperty("user-agent", "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36");
                        int code = c.getResponseCode();
                        if (code == 200) {
                            java.io.InputStream is = c.getInputStream();
                            WebResourceResponse resp = new WebResourceResponse("image/jpeg", "UTF-8", is);
                            return resp;
                        }
                    } catch (Exception e) {
                        Log.e("PAN", "thumb intercept fail: " + url, e);
                    }
                    return new WebResourceResponse("text/plain", "UTF-8", new java.io.ByteArrayInputStream(new byte[0]));
                }
                return super.shouldInterceptRequest(view, url);
            }

            @Override
            public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) {
                super.onPageStarted(view, url, favicon);
                // 官方登录页按设备宽度渲染（禁用 wide viewport，避免阿里云滑块/浮层比视口宽无法拖动）；
                // 本地 SPA 保持移动端宽视口
                if (url != null && url.contains("123pan.cn")) {
                    WebSettings s = view.getSettings();
                    s.setUseWideViewPort(false);
                    s.setLoadWithOverviewMode(false);
                    s.setSupportZoom(false);
                } else if (url != null && url.startsWith("file://")) {
                    WebSettings s = view.getSettings();
                    s.setUseWideViewPort(true);
                    s.setLoadWithOverviewMode(true);
                    s.setSupportZoom(false);
                }
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                super.onPageFinished(view, url);
                if (url != null && url.startsWith("file://")) {
                    // 本地 SPA：注入持久化登录态（登录成功/已登录恢复会话）
                    String token = prefs.getString(KEY_TOKEN, "");
                    String user = prefs.getString(KEY_USER, "");
                    if (!token.isEmpty()) {
                        view.evaluateJavascript(
                            "window.__restoreSession&&window.__restoreSession("
                            + bindJson(json(token)) + "," + bindJson(json(user)) + ");", null);
                    }
                } else if (url != null && url.contains("123pan.cn")) {
                    // 官方登录页：注入常驻文字提示，提醒用户若验证码滑块超出屏幕无法顺畅拖动请横屏操作。
                    // 背景（真机实测）：阿里云滑块轨道固定 360 CSS px。竖屏 CSS 视口仅 347px(iw=347,dpr=3.5)，轨道物理上横贯整个屏幕
                    // 无法顺畅把滑块从左拖到最右；横屏 CSS 视口 iw=715 > 360，轨道完整显示可顺畅拖动。
                    // 注意：绝不缩窄轨道宽度——阿里云滑块判定用绝对 moveX 像素对齐服务端 gapX，缩窄会缩短 moveX 可达范围导致
                    // 拖到最右也够不到缺口判定失败。故仅加文字提示，不改任何轨道CSS、不加自动横屏。
                    // 注入位置：插到登录按钮下方固定标语"验证即登录，未注册将自动创建账号"(P._autoTip)文字后面。
                    // 该标语在账号登录/验证码登录两种模式下都存在(验证码模式下位于"获取验证码"按钮下方)，
                    // 故此处注入两种模式统一且位于按钮正下方，符合"验证码登录界面获取验证码按钮下方"的显示预期。
                    view.evaluateJavascript(
                        "function addLandTip(){try{if(document.getElementById('__panLandTip'))return;var all=document.querySelectorAll('*');var p=null;for(var i=0;i<all.length;i++){var e=all[i];if(e.childNodes&&e.childNodes.length===1&&e.childNodes[0].nodeType===3&&(e.textContent||'').indexOf('自动创建账号')!=-1){p=e;break;}}if(!p)return;var tip=document.createElement('div');tip.id='__panLandTip';tip.style.cssText='margin-top:7px;color:#ff6b00;font-size:11px;line-height:1.4;text-align:center;font-weight:bold;';tip.textContent='若验证码滑块超出屏幕无法顺畅拖动，请将手机横屏后操作';p.parentNode.insertBefore(tip,p.nextSibling);}catch(e){}}"
                        + "addLandTip();setInterval(addLandTip,1500);",
                        null);
                    // 尝试捕获 sso-token，成功则回到本地 SPA
                    tryCaptureSsoTokenFromMain();
                }
            }
        });

        // 下载支持：a[download]/新窗口下载 URL 经 DownloadManager 落盘到 Download 目录
        webView.setDownloadListener(new DownloadListener() {
            @Override
            public void onDownloadStart(String url, String userAgent,
                                        String contentDisposition, String mimetype, long contentLength) {
                downloadViaManager(url, inferName(url, contentDisposition, mimetype));
            }
        });

        // 未登录：直接显示官方登录页（账号密码 / 验证码登录均在官方页完成，含安全滑块）
        // 已登录：加载本地 SPA 恢复会话
        String savedToken = prefs.getString(KEY_TOKEN, "");
        if (savedToken != null && !savedToken.isEmpty()) {
            webView.loadUrl("file:///android_asset/index.html");
        } else {
            webView.loadUrl(OFFICIAL_LOGIN_URL);
        }
    }

    private static String json(String s) {
        if (s == null) return "";
        return s.replace("\\", "\\\\").replace("\"", "\\\"").replace("\n", "\\n");
    }

    private static String bindJson(String s) {
        return "\"" + s + "\"";
    }

    private void toast(final String msg) {
        handler.post(new Runnable() {
            @Override public void run() {
                Toast.makeText(MainActivity.this, msg, Toast.LENGTH_SHORT).show();
            }
        });
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == FILE_CHOOSER_REQUEST) {
            if (uploadMessage == null) return;
            Uri[] results = null;
            if (resultCode == RESULT_OK && data != null) {
                if (data.getClipData() != null) {
                    int n = data.getClipData().getItemCount();
                    results = new Uri[n];
                    for (int i = 0; i < n; i++) {
                        results[i] = data.getClipData().getItemAt(i).getUri();
                    }
                } else if (data.getData() != null) {
                    results = new Uri[]{ data.getData() };
                }
            }
            if (results == null) {
                // 用户取消，通知前端
                uploadMessage.onReceiveValue(null);
                uploadMessage = null;
                return;
            }
            // 将 URI 拷贝为本地临时文件（文件选择器常提供只读 content:// URI）
            String[] paths = new String[results.length];
            for (int i = 0; i < results.length; i++) {
                paths[i] = copyUriToTemp(results[i]);
            }
            uploadMessage.onReceiveValue(results);
            uploadMessage = null;
            // 回传路径给前端，供后续上传
            final String jsList = buildPathsJson(paths);
            handler.post(new Runnable() {
                @Override public void run() {
                    webView.evaluateJavascript(
                        "window.__onFilesPicked&&window.__onFilesPicked(" + jsList + ");", null);
                }
            });
        }

        // 文件夹上传：SAF 目录树选择回调（后台线程遍历 + 拷贝，完成后再通知前端）
        if (requestCode == FOLDER_PICK_REQUEST) {
            final Uri treeUri = (data != null ? data.getData() : null);
            if (treeUri == null) return;
            executor.execute(new Runnable() {
                @Override public void run() {
                    final String jsList = buildFolderPickedJson(treeUri);
                    handler.post(new Runnable() {
                        @Override public void run() {
                            if (webView != null) {
                                webView.evaluateJavascript(
                                    "window.__onFolderPicked&&window.__onFolderPicked(" + jsList + ");", null);
                            }
                        }
                    });
                }
            });
            return;
        }

        // 下载目录选择：取所选目录名作为下载子目录
        if (requestCode == DOWNLOAD_DIR_PICK_REQUEST) {
            if (resultCode != RESULT_OK || data == null || data.getData() == null) return;
            Uri treeUri = data.getData();
            String dirName = "123云盘";
            try {
                // 从 treeUri 取最后一段作为目录名
                String last = treeUri.getLastPathSegment();
                if (last != null) {
                    // 格式类似 "primary:Download/MyDir"，取冒号后最后一段
                    int colon = last.indexOf(':');
                    if (colon >= 0) last = last.substring(colon + 1);
                    // 取最后一段
                    int slash = last.lastIndexOf('/');
                    if (slash >= 0) last = last.substring(slash + 1);
                    if (last != null && !last.isEmpty()) dirName = last;
                }
            } catch (Exception ignore) {}
            final String finalName = dirName;
            setDownloadSubDir(finalName);
            handler.post(new Runnable() {
                @Override public void run() {
                    toast("下载目录已设为 /Download/" + finalName);
                    if (webView != null) {
                        webView.evaluateJavascript(
                            "window.__onDownloadDirPicked&&window.__onDownloadDirPicked('"
                            + finalName.replace("'", "\\'") + "');", null);
                    }
                }
            });
            return;
        }
}

    // 将 content:// URI 拷贝为外部缓存临时文件，返回可读路径
    private String copyUriToTemp(Uri uri) {
        try {
            String name = "upload_" + System.currentTimeMillis() + ".bin";
            try {
                android.database.Cursor c = getContentResolver().query(uri, null, null, null, null);
                if (c != null && c.moveToFirst()) {
                    int idx = c.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                    if (idx >= 0 && c.getString(idx) != null) {
                        name = c.getString(idx);
                    }
                    c.close();
                }
            } catch (Exception ignore) { }
            File tmp = new File(getExternalCacheDir(), name);
            InputStream in = getContentResolver().openInputStream(uri);
            FileOutputStream out = new FileOutputStream(tmp);
            byte[] buf = new byte[8192];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            out.flush(); out.close(); in.close();
            return tmp.getAbsolutePath();
        } catch (Exception e) {
            Log.e("PAN", "copyUriToTemp fail: " + uri + " -> " + e);
            return uri.toString();
        }
    }

    // 生成 JS 数组字符串（路径列表）
    private String buildPathsJson(String[] paths) {
        StringBuilder sb = new StringBuilder("[");
        for (int i = 0; i < paths.length; i++) {
            if (i > 0) sb.append(",");
            sb.append("\"").append(json(paths[i])).append("\"");
        }
        sb.append("]");
        return sb.toString();
    }

    // ============ 文件夹上传：SAF 目录树遍历 ============
    // 遍历用户选择的目录树（DocumentsContract API，无第三方依赖），
    // 把全部文件拷贝到应用缓存（保留相对路径结构，同名文件互不冲突），
    // 生成 [{rel,name,path,size}] JSON 供前端按目录结构创建云端文件夹并依次入队上传。
    private String buildFolderPickedJson(Uri treeUri) {
        java.util.List<String[]> files = new java.util.ArrayList<String[]>();
        try {
            String rootId = android.provider.DocumentsContract.getTreeDocumentId(treeUri);
            String rootName = queryDocName(treeUri, rootId);
            if (rootName == null || rootName.isEmpty()) rootName = "upload_" + System.currentTimeMillis();
            java.io.File outRoot = new java.io.File(getExternalCacheDir(), "updir_" + System.currentTimeMillis());
            if (!outRoot.exists()) outRoot.mkdirs();
            int[] cnt = new int[]{ 0 };
            walkDocTree(treeUri, rootId, rootName, outRoot, files, cnt);
        } catch (Exception e) {
            Log.e("PAN", "buildFolderPickedJson fail: " + e, e);
        }
        StringBuilder sb = new StringBuilder("[");
        for (int i = 0; i < files.size(); i++) {
            if (i > 0) sb.append(",");
            String[] f = files.get(i);
            sb.append("{\"rel\":\"").append(json(f[0])).append("\"");
            sb.append(",\"name\":\"").append(json(f[1])).append("\"");
            sb.append(",\"path\":\"").append(json(f[2])).append("\"");
            sb.append(",\"size\":").append(f[3]).append("}");
        }
        sb.append("]");
        logDl("folder picked files=" + files.size());
        return sb.toString();
    }
    // 递归遍历 SAF 目录树（最多 2000 个文件）
    private void walkDocTree(Uri treeUri, String docId, String relPrefix, java.io.File outDir,
                             java.util.List<String[]> out, int[] cnt) {
        try {
            Uri childrenUri = android.provider.DocumentsContract.buildChildDocumentsUriUsingTree(treeUri, docId);
            android.database.Cursor c = getContentResolver().query(childrenUri,
                new String[]{ android.provider.DocumentsContract.Document.COLUMN_DOCUMENT_ID,
                              android.provider.DocumentsContract.Document.COLUMN_DISPLAY_NAME,
                              android.provider.DocumentsContract.Document.COLUMN_MIME_TYPE,
                              android.provider.DocumentsContract.Document.COLUMN_SIZE }, null, null, null);
            if (c == null) return;
            while (c.moveToNext()) {
                if (cnt[0] >= 2000) break;
                String cid = c.getString(0);
                String cname = c.getString(1);
                String ctype = c.getString(2);
                if (cname == null || cname.isEmpty()) continue;
                String rel = relPrefix + "/" + cname;
                if (android.provider.DocumentsContract.Document.MIME_TYPE_DIR.equals(ctype)) {
                    java.io.File sub = new java.io.File(outDir, cname);
                    sub.mkdirs();
                    walkDocTree(treeUri, cid, rel, sub, out, cnt);
                } else {
                    java.io.File dst = new java.io.File(outDir, cname);
                    if (copyDocToFile(treeUri, cid, dst)) {
                        out.add(new String[]{ rel, cname, dst.getAbsolutePath(), String.valueOf(dst.length()) });
                        cnt[0]++;
                    }
                }
            }
            c.close();
        } catch (Exception e) {
            Log.e("PAN", "walkDocTree fail: " + e, e);
        }
    }
    // 拷贝 SAF 文档到本地文件
    private boolean copyDocToFile(Uri treeUri, String docId, java.io.File dst) {
        try {
            Uri docUri = android.provider.DocumentsContract.buildDocumentUriUsingTree(treeUri, docId);
            java.io.InputStream in = getContentResolver().openInputStream(docUri);
            if (in == null) return false;
            java.io.FileOutputStream fos = new java.io.FileOutputStream(dst);
            byte[] buf = new byte[8192];
            int n;
            while ((n = in.read(buf)) > 0) fos.write(buf, 0, n);
            fos.flush(); fos.close(); in.close();
            return true;
        } catch (Exception e) {
            Log.e("PAN", "copyDocToFile fail: " + e);
            return false;
        }
    }
    // 查询 SAF 文档的显示名（用于根目录命名）
    private String queryDocName(Uri treeUri, String docId) {
        try {
            Uri docUri = android.provider.DocumentsContract.buildDocumentUriUsingTree(treeUri, docId);
            android.database.Cursor c = getContentResolver().query(docUri,
                new String[]{ android.provider.DocumentsContract.Document.COLUMN_DISPLAY_NAME }, null, null, null);
            if (c != null && c.moveToFirst()) {
                String n = c.getString(0);
                c.close();
                return n;
            }
        } catch (Exception ignore) { }
        return null;
    }

    @Override
    public void onBackPressed() {
        // 安全验证模式：按返回键回到App主界面
        if (verifyMode) {
            verifyMode = false;
            // 恢复默认UA
            webView.getSettings().setUserAgentString(null);
            webView.loadUrl("file:///android_asset/index.html");
            // 延迟通知前端刷新回收站列表
            handler.postDelayed(() -> {
                webView.evaluateJavascript("try{window.__onVerifyDone&&window.__onVerifyDone();}catch(e){}", null);
            }, 500);
            return;
        }
        // 前端的回退（面包屑/抽屉）交给 JS；仅在没有可回退时退出
        handler.post(new Runnable() {
            @Override public void run() {
                webView.evaluateJavascript(
                    "window.__handleBack&&window.__handleBack();", null);
            }
        });
    }

    @Override
    protected void onPause() {
        super.onPause();
        // 进入后台：通知前端停止扫码轮询，避免在 cached 状态产生过量
        // HTTP 请求 / JS 桥 binder 流量（此前被系统以 EXCESSIVE CPU/RESOURCE
        // USAGE 杀死，根因正是后台持续轮询）。
        if (webView != null) {
            webView.onPause();
            handler.post(new Runnable() {
                @Override public void run() {
                    webView.evaluateJavascript(
                        "window.__onAppPause&&window.__onAppPause();", null);
                }
            });
        }
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (webView != null) {
            webView.onResume();
            handler.post(new Runnable() {
                @Override public void run() {
                    webView.evaluateJavascript(
                        "window.__onAppResume&&window.__onAppResume();", null);
                }
            });
        }
    }


    // 使用系统 DownloadManager 下载；返回下载任务 ID，若为 -1 表示失败。
    private long downloadViaManager(String url, String name) {
        try {
            String fname = sanitizeFileName(name);
            if (fname == null || fname.isEmpty()) fname = "download_" + System.currentTimeMillis();
            DownloadManager.Request req = new DownloadManager.Request(Uri.parse(url));
            req.setTitle(fname);
            req.setDescription("123云盘下载");
            req.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
            req.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, getDownloadSubDir() + "/" + fname);
            DownloadManager dm = (DownloadManager) getSystemService(Context.DOWNLOAD_SERVICE);
            long id = dm.enqueue(req);
            Log.d("PAN", "download enqueued: " + fname + " id=" + id);
            toast("已加入下载任务：" + downloadRelPath() + "/" + fname);
            return id;
        } catch (Exception e) {
            Log.e("PAN", "downloadViaManager fail: " + url + " -> " + e, e);
            toast("下载失败：" + (e != null && e.getMessage() != null ? e.getMessage() : e));
            return -1;
        }
    }

    // 从 content-disposition / filename 参数 推断友好文件名
    private String inferName(String url, String contentDisposition, String mimetype) {
        String name = null;
        try {
            if (contentDisposition != null) {
                int i = contentDisposition.indexOf("filename=");
                if (i >= 0) {
                    name = contentDisposition.substring(i + 9).trim();
                    name = name.replace("\"", "").replace("'", "");
                    int semi = name.indexOf(";");
                    if (semi > 0) name = name.substring(0, semi).trim();
                }
            }
        } catch (Exception ignore) { }
        if (name == null || name.isEmpty()) {
            try {
                String q = new URL(url).getQuery();
                if (q != null) {
                    for (String p : q.split("&")) {
                        if (p.startsWith("filename=")) name = java.net.URLDecoder.decode(p.substring(9), "UTF-8");
                    }
                }
            } catch (Exception ignore) { }
        }
        if (name == null || name.isEmpty()) {
            try { name = new URL(url).getPath(); } catch (Exception ignore) { }
            if (name != null) {
                String[] seg = name.split("/");
                name = seg.length > 0 ? seg[seg.length - 1] : null;
            }
        }
        if (name == null || name.isEmpty()) name = "download_" + System.currentTimeMillis();
        return name;
    }

    private String sanitizeFileName(String n) {
        if (n == null) return null;
        StringBuilder sb = new StringBuilder(n.length());
        for (int i = 0; i < n.length(); i++) {
            char c = n.charAt(i);
            if (c == '/' || c == '\\' || c == ':' || c == '*' || c == '?'
                || c == '"' || c == '<' || c == '>' || c == '|') {
                sb.append('_');
            } else {
                sb.append(c);
            }
        }
        String r = sb.toString();
        if (r.length() > 120) r = r.substring(r.length() - 120);
        return r;
    }

    // ============ 自研流式下载（严格校验字节完整性） ============
    // 根因：系统 DownloadManager 用默认 UA 直连 123pan 下载直链时，可能被服务端
    // 重定向/拦截返回错误页或截断内容，却标记 STATUS_SUCCESSFUL(8)，导致"未下载完就显示完成"。
    // 自研下载器带上与 API 一致的认证头请求直链，并按 expectedSize 严格校验，
    // 只有真实写盘字节数 >= 期望大小才标记成功(status 8)，否则标记失败(16)。
    // 123pan 的 DownloadUrl 可能是 download-v2/?params= 中转跳转页，需递归解析出真实 CDN 直链。
    // 返回任务 id（>=900000000 表示原生任务）；失败返回 -1。
    public long downloadStream(final String url, final String filename, final long expectedSize) {
        try {
            final String fname = sanitizeFileName(filename);
            final long taskId = nextTaskId++;
            DlTask t = new DlTask();
            t.id = taskId;
            t.url = url;
            t.filename = fname;
            t.expected = expectedSize;
            t.status = 1;
            dlTasks.put(taskId, t);
            logDl("downloadStream CALLED fname=" + fname + " expected=" + expectedSize + " url=" + url);
            startDlThread(t);
            Log.d("PAN", "stream dl enqueued: " + fname + " id=" + taskId + " expected=" + expectedSize);
            return taskId;
        } catch (Exception e) {
            Log.e("PAN", "downloadStream fail: " + e, e);
            logDl("downloadStream EXCEPTION " + e);
            return -1;
        }
    }
    /** 下载任务实体（支持暂停 / 继续 / 重试 / 断点续传） */
    static class DlTask {
        long id;
        String url;           // 原始下载 api url
        String filename;      // 落盘文件名
        long expected;        // 期望字节数（严格校验用）
        volatile long done;   // 已写字节
        volatile long total;  // 文件总长（服务端内容长度）
        volatile int status;  // 1=下载中 2=暂停 8=成功 16=失败
        volatile boolean cancelled; // 用户删除任务
        volatile boolean running;   // 执行线程存续标志
        volatile android.net.Uri uri; // MediaStore uri（暂停后继续复用）
        volatile String realPath;     // 成功后的真实路径
    }
    /** 上传任务实体（支持取消） */
    static class UpTask {
        long id;
        String localPath;     // 本地文件路径（临时拷贝）
        long parentFileId;    // 上传父目录
        volatile int status;  // 1=上传中 2=已取消 8=成功 16=失败
        volatile boolean cancelled;
        volatile long done;   // 已上传字节
        volatile long total;  // 总字节
    }
    /** 启动下载线程（runDlTask 内部有 running 去重保护） */
    private void startDlThread(final DlTask t) {
        executor.execute(new Runnable() {
            @Override public void run() { runDlTask(t); }
        });
    }
    /** 执行 / 继续一个下载任务（从 t.done 处断点续传；Range 不被支持时自动从头重下） */
    private void runDlTask(final DlTask t) {
        synchronized (t) {
            if (t.running) return; // 已有线程在执行
            t.running = true;
        }
        if (t.cancelled) { t.running = false; return; }
        t.status = 1;
        logDl("task#" + t.id + " download begin fname=" + t.filename + " from=" + t.done + " expected=" + t.expected);
        // GitHub 更新包（自动更新下载）：走专用路径 —— 直连 + 镜像回退 + 自动重试 + 严格字节校验。
        // 背景：系统 DownloadManager 单一直连 GitHub 在 CN 网络抖动 / 资产域名
        // （release-assets.githubusercontent.com）受限时失败后无任何恢复手段，改为自研多候选下载。
        if (isGithubUpdateUrl(t.url)) {
            logDl("task#" + t.id + " route to github update downloader");
            runGithubUpdateDownload(t);
            return;
        }
        java.io.OutputStream out = null;
        HttpURLConnection conn = null;
        final MainActivity act = this;
        try {
            // ---- 多级解析最终真实下载直链 ----
            String finalUrl = resolveRealDownloadUrl(t.url, t.filename);
            logDl("task#" + t.id + " resolve finalUrl=" + finalUrl);
            if (finalUrl == null) {
                t.status = 16;
                logDl("task#" + t.id + " resolve FAILED (no real url)");
                return;
            }
            conn = (HttpURLConnection) new URL(finalUrl).openConnection();
            conn.setConnectTimeout(20000);
            conn.setReadTimeout(120000);
            conn.setRequestMethod("GET");
            conn.setInstanceFollowRedirects(true);
            String token = prefs.getString(KEY_TOKEN, "");
            conn.setRequestProperty("user-agent", "123pan/v2.4.0(" + osVersion + ";Xiaomi)");
            conn.setRequestProperty("authorization", token.isEmpty() ? "" : "Bearer " + token);
            conn.setRequestProperty("osversion", osVersion);
            conn.setRequestProperty("platform", "web");
            conn.setRequestProperty("devicetype", deviceType);
            conn.setRequestProperty("devicename", devicename);
            conn.setRequestProperty("app-version", "61");
            conn.setRequestProperty("x-app-version", "2.4.0");
            conn.setRequestProperty("Origin", "https://yun.123pan.cn");
            conn.setRequestProperty("Referer", "https://yun.123pan.cn/");
            long resumeFrom = t.done;
            if (resumeFrom > 0) {
                conn.setRequestProperty("Range", "bytes=" + resumeFrom + "-");
            }
            int code = conn.getResponseCode();
            boolean ranged = false;
            long contentLen = conn.getContentLengthLong();
            if (resumeFrom > 0) {
                if (code == 206) {
                    ranged = true; // 断点续传成功（服务器支持 Range）
                } else if (code == 200) {
                    // 服务器忽略 Range：从头重下（截断写）
                    logDl("task#" + t.id + " server ignored Range, restart from 0");
                    resumeFrom = 0;
                    t.done = 0;
                }
            }
            logDl("task#" + t.id + " HTTP " + code + " len=" + contentLen + " ranged=" + ranged
                + " tokenEmpty=" + (token == null || token.isEmpty()));
            if (code < 200 || code >= 300) {
                t.status = 16;
                Log.e("PAN", "stream dl HTTP " + code + " for " + t.filename);
                return;
            }
            t.total = ranged ? (resumeFrom + contentLen) : (contentLen > 0 ? contentLen : t.expected);
            if (t.total <= 0) t.total = t.expected;
            // ---- MediaStore 落盘准备（续传复用同一 uri） ----
            if (t.uri == null) {
                android.content.ContentValues cv = new android.content.ContentValues();
                cv.put(android.provider.MediaStore.MediaColumns.DISPLAY_NAME, t.filename);
                String mime = t.filename != null && t.filename.toLowerCase().endsWith(".apk")
                    ? "application/vnd.android.package-archive"
                    : "application/octet-stream";
                cv.put(android.provider.MediaStore.MediaColumns.MIME_TYPE, mime);
                cv.put(android.provider.MediaStore.MediaColumns.RELATIVE_PATH, downloadRelPath());
                cv.put(android.provider.MediaStore.MediaColumns.IS_PENDING, 1);
                android.net.Uri itemUri = act.getContentResolver().insert(
                    android.provider.MediaStore.Downloads.EXTERNAL_CONTENT_URI, cv);
                logDl("task#" + t.id + " MediaStore insert uri=" + (itemUri != null ? itemUri.toString() : "NULL"));
                if (itemUri == null) { t.status = 16; Log.e("PAN", "stream dl: MediaStore insert fail"); return; }
                t.uri = itemUri;
            }
            java.io.InputStream in = conn.getInputStream();
            if (ranged) {
                out = act.getContentResolver().openOutputStream(t.uri, "wa"); // 断点追加
            } else {
                out = act.getContentResolver().openOutputStream(t.uri, "w");  // 从头写（截断）
            }
            if (out == null) { t.status = 16; logDl("task#" + t.id + " openOutputStream NULL"); return; }
            byte[] buf = new byte[65536];
            long written = resumeFrom;
            int n;
            while ((n = in.read(buf)) > 0) {
                if (t.cancelled) { // 任务已删除：停止并退出
                    out.flush(); out.close(); out = null;
                    logDl("task#" + t.id + " CANCELLED at " + written);
                    return;
                }
                if (t.status == 2) { // 暂停：保存进度退出，等待继续
                    out.flush(); out.close(); out = null;
                    t.done = written;
                    logDl("task#" + t.id + " PAUSED at " + written);
                    return;
                }
                out.write(buf, 0, n);
                written += n;
                t.done = written;
            }
            out.flush(); out.close(); out = null;
            // 清除"不可见"标记，让文件立即可见
            android.content.ContentValues pend = new android.content.ContentValues();
            pend.put(android.provider.MediaStore.MediaColumns.IS_PENDING, 0);
            act.getContentResolver().update(t.uri, pend, null, null);
            String realPath = queryMediaDataPath(act, t.uri);
            // 严格校验：实际写盘字节数必须 >= 期望字节（若期望已知）
            if (t.expected <= 0 || written >= t.expected) {
                t.status = 8; // 成功
                t.realPath = realPath != null ? realPath : t.uri.toString();
                streamTaskFiles.put(t.id, t.realPath);
                streamTaskUris.put(t.id, t.uri.toString()); // 供打开 / 安装优先用 MediaStore URI
                Log.d("PAN", "stream dl ok: " + t.filename + " id=" + t.id + " bytes=" + written);
                logDl("task#" + t.id + " SUCCESS " + t.filename + " bytes=" + written + " expected=" + t.expected);
            } else {
                t.status = 16; // 字节数不足 -> 失败
                try { act.getContentResolver().delete(t.uri, null, null); } catch (Exception ignore) {}
                t.uri = null;
                t.done = 0; // 文件已删除，重试必须从头开始
                Log.w("PAN", "stream dl incomplete: " + t.filename + " got " + written
                    + " expected " + t.expected);
                logDl("task#" + t.id + " INCOMPLETE " + t.filename + " got=" + written + " expected=" + t.expected);
            }
        } catch (Exception e) {
            if (!t.cancelled) t.status = 16;
            Log.e("PAN", "stream dl fail: " + (t.filename == null ? "" : t.filename) + " -> " + e, e);
            logDl("task#" + t.id + " EXCEPTION " + e);
        } finally {
            try { if (out != null) out.close(); } catch (Exception ignore) {}
            if (conn != null) conn.disconnect();
            t.running = false;
        }
    }
    // ===== GitHub 更新包下载（自动更新专用）：直连 + 镜像回退 + 自动重试 + 严格字节校验 =====
    /** GitHub 更新包下载的镜像前缀（直连失败后按顺序回退） */
    private static final String[] GITHUB_MIRROR_PREFIXES = new String[] {
        "https://ghfast.top/",
        "https://gh-proxy.com/",
        "https://ghproxy.net/",
        "https://gh.llkk.cc/"
    };

    /** 判断是否为 GitHub 更新包下载（自动更新场景：github.com / 镜像地址） */
    private boolean isGithubUpdateUrl(String url) {
        if (url == null) return false;
        String u = url.toLowerCase();
        return u.contains("github.com/") || u.contains("githubusercontent.com/")
            || u.contains("ghfast.top/") || u.contains("gh-proxy.com/")
            || u.contains("ghproxy.net/") || u.contains("gh.llkk.cc/");
    }

    /** 构建 GitHub 下载候选链：官方直连优先，随后逐个镜像前缀 */
    private java.util.List<String> buildGithubCandidates(String url) {
        java.util.List<String> list = new java.util.ArrayList<String>();
        if (url == null) return list;
        String u = url.trim();
        boolean isMirror = u.contains("ghfast.top/") || u.contains("gh-proxy.com/")
            || u.contains("ghproxy.net/") || u.contains("gh.llkk.cc/");
        if (isMirror) { list.add(u); return list; } // 已是镜像形态：只试自身，避免套娃
        list.add(u);
        for (String m : GITHUB_MIRROR_PREFIXES) list.add(m + u);
        return list;
    }

    /**
     * GitHub 更新包下载主流程：多候选（直连+镜像）× 多轮重试；任一候选成功即完成。
     * 调用前 t.running 已置 true；本方法负责在所有出口复位 t.running。
     */
    private void runGithubUpdateDownload(final DlTask t) {
        try {
            logDl("task#" + t.id + " github dl: fname=" + t.filename + " expected=" + t.expected + " url=" + t.url);
            java.util.List<String> candidates = buildGithubCandidates(t.url);
            if (candidates.isEmpty()) { t.status = 16; return; }
            final int rounds = 2; // 全候选失败后整体再来一轮
            for (int round = 0; round < rounds; round++) {
                if (t.cancelled) return;
                for (int ci = 0; ci < candidates.size(); ci++) {
                    if (t.cancelled) return;
                    if (t.status == 2) { logDl("task#" + t.id + " paused before try"); return; }
                    String cand = candidates.get(ci);
                    logDl("task#" + t.id + " try[" + round + "." + ci + "] " + cand);
                    boolean ok = attemptGithubDownload(t, cand);
                    if (ok) {
                        t.status = 8;
                        logDl("task#" + t.id + " SUCCESS via try[" + round + "." + ci + "]");
                        return;
                    }
                    if (t.cancelled) return;
                    if (t.status == 2) { logDl("task#" + t.id + " paused after try"); return; }
                    try { Thread.sleep(900); } catch (InterruptedException ignore) {}
                }
                if (round < rounds - 1) {
                    logDl("task#" + t.id + " all candidates failed, retry round " + (round + 1));
                    try { Thread.sleep(2500); } catch (InterruptedException ignore) {}
                }
            }
            t.status = 16;
            t.done = 0;
            logDl("task#" + t.id + " FAILED after all candidates/rounds");
        } catch (Exception e) {
            t.status = 16;
            t.done = 0;
            logDl("task#" + t.id + " github dl EXCEPTION " + e);
        } finally {
            t.running = false;
        }
    }

    /**
     * 单次尝试：从指定 URL 完整下载到 MediaStore，并做严格字节校验。
     * 成功返回 true；失败/取消/暂停返回 false（失败时清理半成品，避免残留）。
     * 注意：GitHub 场景不带任何 123pan 认证头，避免污染官方/镜像请求。
     */
    private boolean attemptGithubDownload(final DlTask t, String url) {
        final MainActivity act = this;
        HttpURLConnection conn = null;
        java.io.OutputStream out = null;
        android.net.Uri itemUri = null;
        long written = 0;
        try {
            conn = (HttpURLConnection) new java.net.URL(url).openConnection();
            conn.setConnectTimeout(8000);
            conn.setReadTimeout(30000);
            conn.setRequestMethod("GET");
            conn.setInstanceFollowRedirects(true);
            conn.setRequestProperty("User-Agent",
                "Mozilla/5.0 (Linux; Android14; Mobile) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36");
            conn.setRequestProperty("Accept", "application/octet-stream,*/*");
            int code = conn.getResponseCode();
            if (code < 200 || code >= 300) {
                logDl("task#" + t.id + " github http " + code + " for " + url);
                return false;
            }
            long len = conn.getContentLengthLong();
            long want = t.expected > 0 ? t.expected : (len > 0 ? len : 0);
            android.content.ContentValues cv = new android.content.ContentValues();
            cv.put(android.provider.MediaStore.MediaColumns.DISPLAY_NAME, t.filename);
            String mime = t.filename != null && t.filename.toLowerCase().endsWith(".apk")
                ? "application/vnd.android.package-archive" : "application/octet-stream";
            cv.put(android.provider.MediaStore.MediaColumns.MIME_TYPE, mime);
            cv.put(android.provider.MediaStore.MediaColumns.RELATIVE_PATH, downloadRelPath());
            cv.put(android.provider.MediaStore.MediaColumns.IS_PENDING, 1);
            itemUri = act.getContentResolver().insert(
                android.provider.MediaStore.Downloads.EXTERNAL_CONTENT_URI, cv);
            if (itemUri == null) { logDl("task#" + t.id + " mediastore insert null"); return false; }
            java.io.InputStream in = conn.getInputStream();
            out = act.getContentResolver().openOutputStream(itemUri, "w");
            if (out == null) { logDl("task#" + t.id + " openOutputStream null"); cleanupMediaUri(itemUri); return false; }
            byte[] buf = new byte[65536];
            int n;
            while ((n = in.read(buf)) > 0) {
                if (t.cancelled || t.status == 2) break; // 取消/暂停：退出写流
                out.write(buf, 0, n);
                written += n;
                t.done = written;
                if (t.total <= 0 && len > 0) t.total = len;
            }
            out.flush(); out.close(); out = null;
            if (t.cancelled || t.status == 2) { // 取消/暂停：删除半成品，重试从头
                cleanupMediaUri(itemUri);
                t.done = 0;
                logDl("task#" + t.id + " aborted(cancelled/paused) at " + written);
                return false;
            }
            if (want > 0 && written < want) { // 严格字节校验：绝不让不完整内容留存
                logDl("task#" + t.id + " incomplete got=" + written + " want=" + want + " url=" + url);
                cleanupMediaUri(itemUri);
                t.done = 0;
                return false;
            }
            // 校验通过：清除 pending 标记，立即可见
            android.content.ContentValues pend = new android.content.ContentValues();
            pend.put(android.provider.MediaStore.MediaColumns.IS_PENDING, 0);
            act.getContentResolver().update(itemUri, pend, null, null);
            String realPath = queryMediaDataPath(act, itemUri);
            t.uri = itemUri;
            t.realPath = realPath != null ? realPath : itemUri.toString();
            t.done = written;
            t.total = written;
            streamTaskFiles.put(t.id, t.realPath);
            streamTaskUris.put(t.id, itemUri.toString());
            logDl("task#" + t.id + " github ok bytes=" + written + " via " + url);
            return true;
        } catch (Exception e) {
            if (!t.cancelled && t.status != 2) logDl("task#" + t.id + " github attempt fail: " + e);
            if (itemUri != null) cleanupMediaUri(itemUri);
            t.done = 0;
            return false;
        } finally {
            try { if (out != null) out.close(); } catch (Exception ignore) {}
            try { if (conn != null) conn.disconnect(); } catch (Exception ignore) {}
        }
    }

    /** 清理 MediaStore 半成品条目 */
    private void cleanupMediaUri(android.net.Uri u) {
        if (u == null) return;
        try { getContentResolver().delete(u, null, null); } catch (Exception ignore) {}
    }

    /** 暂停下载任务（下载线程在下一数据块边界退出并保留断点） */
    public void pauseDownload(final long taskId) {
        DlTask t = dlTasks.get(taskId);
        if (t == null) return;
        if (t.status == 1) {
            t.status = 2;
            logDl("task#" + taskId + " pause requested");
        }
    }
    /** 继续 / 重试下载任务：线程仍在则原地恢复，已退出则从断点续传 */
    public void resumeDownload(final long taskId) {
        DlTask t = dlTasks.get(taskId);
        if (t == null) return;
        if (t.running) {
            // 线程尚未退出（暂停等待中）：直接改回下载中即可原地继续
            if (t.status == 2) { t.status = 1; logDl("task#" + taskId + " resume in-place"); }
            return;
        }
        if (t.status == 2 || t.status == 16) {
            t.status = 1;
            logDl("task#" + taskId + " resume from=" + t.done);
            startDlThread(t);
        }
    }
    /** 重试（语义同继续：从断点或从头重新下载） */
    public void retryDownload(final long taskId) {
        resumeDownload(taskId);
    }
    /** 删除任务：取消执行；未完成的半成品文件一并删除（已完成文件保留） */
    public void deleteDownloadTask(final long taskId) {
        DlTask t = dlTasks.get(taskId);
        if (t == null) return;
        t.cancelled = true;
        if (t.status != 8 && t.uri != null) {
            try { getContentResolver().delete(t.uri, null, null); } catch (Exception ignore) {}
        }
        dlTasks.remove(taskId);
        logDl("task#" + taskId + " deleted");
    }
        // 解析 123pan 的多级下载直链，返回真正可直接流式下载的最终 CDN URL。
    // 处理两种中转：
    //  1) DownloadUrl 形如 ..../download-v2/?params=<base64>&is_s3=0 —— 直接 base64 解码 params 得真实 S3 直链
    //  2) GET 真实 S3 直链若返回 HTTP 210 + JSON{code,data.redirect_url} —— 取其 redirect_url 作为最终 URL
    // 返回最终直链；无法解析则返回 null。
    private String resolveRealDownloadUrl(String url, String fname) {
        try {
            String cur = url;
            for (int hop = 0; hop < 8; hop++) {
                if (cur == null || cur.isEmpty()) return null;
                logDl("resolve hop" + hop + " url=" + cur);
                // 情况1：download-v2 中转页 —— 从 query 提取 params(base64) 解码出真实 S3 直链
                int pIdx = cur.indexOf("params=");
                if (cur.contains("download-v2") && pIdx >= 0) {
                    String params = cur.substring(pIdx + "params=".length());
                    int amp = params.indexOf('&');
                    if (amp >= 0) params = params.substring(0, amp);
                    // URL 解码
                    params = java.net.URLDecoder.decode(params, "UTF-8");
                    // base64 解码
                    byte[] dec = android.util.Base64.decode(params, android.util.Base64.DEFAULT);
                    if (dec != null && dec.length > 0) {
                        String real = new String(dec, "UTF-8");
                        cur = real;
                        continue; // 跳到情况2 GET 试探
                    }
                }
                // 对当前候选 URL 发起一次 GET 试探（仅读响应头/小体积响应体判断是否需再跳转）
                HttpURLConnection c = (HttpURLConnection) new URL(cur).openConnection();
                c.setConnectTimeout(15000);
                c.setReadTimeout(20000);
                c.setRequestMethod("GET");
                c.setInstanceFollowRedirects(true);
                String token = prefs.getString(KEY_TOKEN, "");
                c.setRequestProperty("user-agent", "123pan/v2.4.0(" + osVersion + ";Xiaomi)");
                c.setRequestProperty("authorization", token.isEmpty() ? "" : "Bearer " + token);
                c.setRequestProperty("osversion", osVersion);
                c.setRequestProperty("platform", "web");
                c.setRequestProperty("devicetype", deviceType);
                c.setRequestProperty("devicename", devicename);
                c.setRequestProperty("app-version", "61");
                c.setRequestProperty("x-app-version", "2.4.0");
                c.setRequestProperty("Origin", "https://yun.123pan.cn");
                c.setRequestProperty("Referer", "https://yun.123pan.cn/");
                String ctype = c.getContentType();
                int ccode = c.getResponseCode();
                logDl("resolve probe HTTP " + ccode + " type=" + ctype + " len=" + c.getContentLengthLong());
                // HTTP 210：服务端返回 JSON { message, data:{ redirect_url } }
                if (ccode == 210) {
                    java.io.InputStream es = c.getErrorStream();
                    if (es == null) es = c.getInputStream();
                    byte[] body = readAll(es, 65536);
                    c.disconnect();
                    String txt = body != null ? new String(body, "UTF-8") : "";
                    logDl("resolve 210 body=" + (txt.length() > 120 ? txt.substring(0, 120) : txt));
                    int ru = txt.indexOf("redirect_url");
                    if (ru >= 0) {
                        int st = txt.indexOf('"', ru + "redirect_url".length() + 2);
                        if (st >= 0) {
                            int en = txt.indexOf('"', st + 1);
                            if (en > st) {
                                String red = txt.substring(st + 1, en)
                                    .replace("\\/", "/").replace("\\u0026", "&");
                                cur = red;
                                continue;
                            }
                        }
                    }
                    return null;
                }
                // HTTP 200 且是二进制流（application/octet-stream 或非 text/html）-> 最终直链
                if (ccode >= 200 && ccode < 300) {
                    boolean isHtml = ctype != null && ctype.toLowerCase().contains("text/html");
                    if (!isHtml) {
                        String finalUrl = cur;
                        c.disconnect();
                        return finalUrl;
                    }
                    // 仍是 html 壳（可能是别的中转），读 body 尝试从其中提取 downloadv2 参数
                    java.io.InputStream is = c.getInputStream();
                    byte[] body = readAll(is, 65536);
                    c.disconnect();
                    String txt = body != null ? new String(body, "UTF-8") : "";
                    logDl("resolve html shell, try extract params, len=" + txt.length());
                    // 某些中转页 body 里可能直接含 <a href=真实url>，简单尝试找 https:// 直链
                    int hp = txt.indexOf("https://");
                    if (hp >= 0) {
                        int he = txt.indexOf('"', hp);
                        int he2 = txt.indexOf('\'', hp);
                        if (he < 0) he = he2;
                        if (he > hp) {
                            String cand = txt.substring(hp, he);
                            if (cand.contains("download-cdn") || cand.contains("123773.com")
                                || cand.contains("pd1.cjjd19") || cand.contains(".apk")
                                || cand.contains("filename=")) {
                                cur = cand;
                                continue;
                            }
                        }
                    }
                    return null;
                }
                // 其它状态码 -> 失败
                c.disconnect();
                return null;
            }
            return cur;
        } catch (Exception e) {
            logDl("resolve EXCEPTION " + e);
            return null;
        }
    }

    // 读取流全部内容（限制 max），用于解析 210 JSON 或 html 壳；读不到返回 null。
    private byte[] readAll(java.io.InputStream in, int max) {
        try {
            java.io.ByteArrayOutputStream bo = new java.io.ByteArrayOutputStream();
            byte[] buf = new byte[4096];
            int n;
            while ((n = in.read(buf)) > 0) {
                bo.write(buf, 0, n);
                if (bo.size() > max) break;
            }
            try { in.close(); } catch (Exception ignore) {}
            return bo.toByteArray();
        } catch (Exception e) { return null; }
    }

    // 正式版说明：日志仅输出到 Logcat（不再向公共 Download 目录写入任何调试文件）
    private void logDl(String msg) {
        Log.d("PAN", msg);
    }

    // 从 MediaStore 条目查询物理绝对路径（_data），供"打开/安装"使用；查不到返回 null
    private String queryMediaDataPath(MainActivity act, Uri itemUri) {
        try {
            Cursor c = act.getContentResolver().query(itemUri,
                new String[]{ android.provider.MediaStore.MediaColumns.DATA }, null, null, null);
            if (c != null) {
                try {
                    if (c.moveToFirst()) {
                        int idx = c.getColumnIndex(android.provider.MediaStore.MediaColumns.DATA);
                        if (idx >= 0) return c.getString(idx);
                    }
                } finally { c.close(); }
            }
            return null;
        } catch (Exception e) {
            Log.e("PAN", "queryMediaDataPath fail", e);
            return null;
        }
    }

    // 查询自研流式下载任务进度，返回 JSON 数组 [{id,name,total,done,status}]
    public String streamingTasksJson() {
        StringBuilder sb = new StringBuilder("[");
        boolean first = true;
        for (java.util.Map.Entry<Long, DlTask> e : dlTasks.entrySet()) {
            DlTask t = e.getValue();
            if (t == null) continue;
            if (!first) sb.append(",");
            first = false;
            sb.append("{\"id\":").append(t.id);
            sb.append(",\"name\":\"").append(json(t.filename == null ? "" : t.filename)).append("\"");
            sb.append(",\"total\":").append(t.total);
            sb.append(",\"done\":").append(t.done);
            sb.append(",\"status\":").append(t.status);
            sb.append("}");
        }
        sb.append("]");
        return sb.toString();
    }
    // 查询本应用经 DownloadManager 发起的下载任务进度，返回 JSON 数组 [{id,name,total,done,status}]
    // status: 1=下载中 8=成功 16=失败, done/total 单位字节
    public String queryDownloadsJson() {
        StringBuilder sb = new StringBuilder("[");
        try {
            DownloadManager dm = (DownloadManager) getSystemService(Context.DOWNLOAD_SERVICE);
            DownloadManager.Query q = new DownloadManager.Query();
            Cursor c = dm.query(q);
            boolean first = true;
            if (c != null) {
                int idxId = c.getColumnIndex(DownloadManager.COLUMN_ID);
                int idxTitle = c.getColumnIndex(DownloadManager.COLUMN_TITLE);
                int idxDesc = c.getColumnIndex(DownloadManager.COLUMN_DESCRIPTION);
                int idxTotal = c.getColumnIndex(DownloadManager.COLUMN_TOTAL_SIZE_BYTES);
                int idxDone = c.getColumnIndex(DownloadManager.COLUMN_BYTES_DOWNLOADED_SO_FAR);
                int idxStatus = c.getColumnIndex(DownloadManager.COLUMN_STATUS);
                while (c.moveToNext()) {
                    String desc = c.getString(idxDesc);
                    if (desc == null || !desc.contains("123云盘下载")) continue;
                    if (!first) sb.append(",");
                    first = false;
                    String title = c.getString(idxTitle);
                    long total = c.getLong(idxTotal);
                    long done = c.getLong(idxDone);
                    int st = c.getInt(idxStatus);
                    long id = c.getLong(idxId);
                    sb.append("{\"id\":").append(id);
                    sb.append(",\"name\":\"").append(escapeJson(title)).append("\"");
                    sb.append(",\"total\":").append(total);
                    sb.append(",\"done\":").append(done);
                    sb.append(",\"status\":").append(st);
                    sb.append("}");
                }
                c.close();
            }
        } catch (Exception e) {
            Log.e("PAN", "queryDownloads fail: " + e, e);
        }
        sb.append("]");
        return sb.toString();
    }

    // 转义 JSON 字符串中的特殊字符
    private String escapeJson(String s) {
        if (s == null) return "";
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < s.length(); i++) {
            char ch = s.charAt(i);
            if (ch == '\\') sb.append("\\\\");
            else if (ch == '"') sb.append("\\\"");
            else if (ch == '\n') sb.append("\\n");
            else if (ch == '\r') sb.append("\\r");
            else if (ch == '\t') sb.append("\\t");
            else sb.append(ch);
        }
        return sb.toString();
    }

    private boolean isApk(String n) {
        return n != null && n.toLowerCase().endsWith(".apk");
    }

    // 打开已下载文件：优先 App 私有下载目录（自研流式下载落盘处），其次系统公共 Download 目录（DownloadManager 落盘处）。
    // apk 直接唤醒系统安装程序，其它走系统"打开方式"
    public void openDownloadedFile(String name) {
        try {
            String fname = sanitizeFileName(name);
            logDl("OPEN CALLED name=" + name + " fname=" + fname);
            File f = null;
            // -2) 最可靠：通过 MediaStore 前缀查询 Download 列表，找出文件名匹配（含 "(1)" 后缀）的
            //     IS_PENDING=0 的条目，取最新一个的 content URI 与真实路径。
            //     注意：必须用【去扩展名的 baseName】做 LIKE 前缀，否则带 "(1)" 后缀的文件（DisplayName 变成 xxx (1).apk）
            //     无法被 "xxx.apk%" 匹配到，会误选同名的旧损坏文件（如 5344 字节 HTML 壳）。
            //     即使 app 重启、内存 map 清空，也能定位到新下载的完整文件，避免误打开同名旧损坏文件。
            String baseName = fname;
            if (baseName != null) {
                int idx = baseName.lastIndexOf('.');
                if (idx > 0) baseName = baseName.substring(0, idx);
            }
            Uri bestMediaUri = null;
            String bestMediaPath = null;
            long bestSize = -1;
            try {
                android.database.Cursor c = getContentResolver().query(
                    android.provider.MediaStore.Downloads.EXTERNAL_CONTENT_URI,
                    new String[]{
                        android.provider.MediaStore.MediaColumns._ID,
                        android.provider.MediaStore.MediaColumns.DISPLAY_NAME,
                        android.provider.MediaStore.MediaColumns.SIZE,
                        android.provider.MediaStore.MediaColumns.DATA,
                        android.provider.MediaStore.MediaColumns.IS_PENDING
                    },
                    android.provider.MediaStore.MediaColumns.DISPLAY_NAME + " LIKE ? ",
                    new String[]{ baseName + "%" },
                    android.provider.MediaStore.MediaColumns.DATE_MODIFIED + " DESC");
                if (c != null) {
                    while (c.moveToNext()) {
                        long id = c.getLong(0);
                        String dn = c.getString(1);
                        long size = c.getLong(2);
                        int pending = c.getInt(4);
                        if (dn != null && dn.startsWith(baseName) && pending == 0 && size > 0) {
                            bestMediaUri = android.content.ContentUris.withAppendedId(
                                android.provider.MediaStore.Downloads.EXTERNAL_CONTENT_URI, id);
                            bestMediaPath = c.getString(3);
                            bestSize = size;
                            break; // 取最新一条完整记录
                        }
                    }
                    c.close();
                }
            } catch (Exception ignore) {}
            logDl("OPEN bestMediaUri=" + (bestMediaUri != null ? bestMediaUri.toString() : "null")
                + " size=" + bestSize + " path=" + bestMediaPath);
            // -1) 优先用内存中保存的 MediaStore content URI（自研流式下载成功时保存，本进程内最准）
            java.util.Map.Entry<Long, String> uriEntry = null;
            try {
                for (java.util.Map.Entry<Long, String> en : streamTaskUris.entrySet()) {
                    String p = streamTaskFiles.get(en.getKey());
                    if (p == null) continue;
                    File sf = new File(p);
                    String bn = sf.getName();
                    if (sf.exists() && bn != null && bn.startsWith(fname)) { uriEntry = en; break; }
                }
            } catch (Exception ignore) {}
            logDl("OPEN uriEntry=" + (uriEntry != null ? uriEntry.getValue() : "null"));
            // 0) 按文件名匹配自研流式下载已落盘文件（MediaStore 可能自动加后缀，用 basename 前缀匹配）
            try {
                for (String p : streamTaskFiles.values()) {
                    if (p == null) continue;
                    File sf = new File(p);
                    String bn = sf.getName();
                    if (sf.exists() && bn != null && bn.startsWith(fname)) { f = sf; break; }
                }
            } catch (Exception ignore) {}
            // 1) 系统公共 Download 目录：若已存在精确名文件，优先用 MediaStore 查到的完整文件（bestMediaPath），
            //    否则用 fname 精确匹配（可能是旧 DownloadManager 下载，需要校验大小不误开损坏文件）
            if (f == null && bestMediaPath != null) {
                File bf = new File(bestMediaPath);
                if (bf.exists()) f = bf;
            }
            if (f == null) {
                try {
                    File cd = new File(Environment.getExternalStoragePublicDirectory(
                        downloadRelPath()).getAbsolutePath(), fname);
                    if (cd.exists() && cd.length() > 0) f = cd;
                } catch (Exception ignore) {}
            }
            // 2) App 私有外部下载目录
            if (f == null) {
                try {
                    File pd = new File(getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS).getAbsolutePath(), fname);
                    if (pd.exists() && pd.length() > 0) f = pd;
                } catch (Exception ignore) {}
            }
            logDl("OPEN file=" + (f != null ? f.getAbsolutePath() : "null") + " exists=" + (f != null && f.exists()));
            if (isApk(fname)) {
                // apk：优选 MediaStore content URI（内存 uriEntry > MediaStore 前缀查询 bestMediaUri）唤醒系统包安装器
                Uri apkUri = null;
                if (uriEntry != null) apkUri = Uri.parse(uriEntry.getValue());
                else if (bestMediaUri != null) apkUri = bestMediaUri;
                if (apkUri != null) {
                    try {
                        logDl("OPEN apk via MediaStore uri=" + apkUri);
                        Intent install = new Intent(Intent.ACTION_INSTALL_PACKAGE);
                        install.setDataAndType(apkUri, "application/vnd.android.package-archive");
                        install.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                        install.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                        install.setClipData(ClipData.newRawUri("", apkUri));
                        startActivity(install);
                        logDl("OPEN apk install launched via MediaStore uri");
                        return;
                    } catch (Exception e) {
                        Log.w("PAN", "open apk via MediaStore uri fail, fallback to path: " + e, e);
                        logDl("OPEN MediaStore uri EXCEPTION " + e);
                    }
                }
                if (f == null || !f.exists()) {
                    toast("文件不存在：" + (fname == null ? "" : fname));
                    logDl("OPEN no file found, toast");
                    return;
                }
            } else if (f == null || !f.exists()) {
                toast("文件不存在：" + (fname == null ? "" : fname));
                logDl("OPEN no file found (non-apk), toast");
                return;
            }
            String contentUri = "content://com.yunpan.mobile.pan/file?path=" + Uri.encode(f.getAbsolutePath());
            Uri cu = Uri.parse(contentUri);
            logDl("OPEN via PanProvider uri=" + cu + " size=" + (f != null ? f.length() : 0));
            Log.d("PAN", "open file: " + f.getAbsolutePath());
            if (isApk(fname)) {
                // apk：直接唤醒系统包安装器（不走 chooser，安装必然有软件包安装程序）
                try {
                    Intent install = new Intent(Intent.ACTION_INSTALL_PACKAGE);
                    // 必须用 setDataAndType：分开 setData+setType 会清空 data，导致安装器收不到文件
                    install.setDataAndType(cu, "application/vnd.android.package-archive");
                    install.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                    install.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                    install.setClipData(ClipData.newRawUri("", cu));
                    startActivity(install);
                    logDl("OPEN apk install launched via PanProvider");
                    return;
                } catch (Exception e) {
                    Log.e("PAN", "install direct fail -> chooser: " + e, e);
                    logDl("OPEN PanProvider install EXCEPTION " + e);
                }
            }
            // 其它类型（含 apk 兜底）：系统推荐打开方式
            MimeTypeMap mimeMap = MimeTypeMap.getSingleton();
            String ext = MimeTypeMap.getFileExtensionFromUrl(Uri.fromFile(f).toString());
            String mime = (ext != null) ? mimeMap.getMimeTypeFromExtension(ext.toLowerCase()) : null;
            Intent intent = new Intent(Intent.ACTION_VIEW);
            intent.setDataAndType(cu,
                isApk(fname) ? "application/vnd.android.package-archive"
                    : ((mime != null && !mime.isEmpty()) ? mime : "*/*"));
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            intent.setClipData(ClipData.newRawUri("", cu));
            try {
                startActivity(Intent.createChooser(intent, "打开方式"));
            } catch (Exception e) {
                toast("没有可打开该文件的应用");
            }
        } catch (Exception e) {
            Log.e("PAN", "open fail: " + e, e);
            toast("打开失败：" + (e.getMessage() != null ? e.getMessage() : e));
        }
    }

    @Override
    protected void onDestroy() {
        if (webView != null) webView.destroy();
        if (previewSocket != null) {
            try { previewSocket.close(); } catch (Exception ignore) {}
            previewSocket = null;
        }
        executor.shutdown();
        super.onDestroy();
    }

    /**
     * 在后台线程执行 API 请求，回调前端 JS。
     * 复刻 123pan-open 的端点：
     *   sign_in / file/list/new / download_info / trash / rename / mod_pid / user/info
     */
    private void doApi(final String callback, final String method,
                       final String url, final String body, final boolean withAuth) {
        executor.execute(new Runnable() {
            @Override public void run() {
                String result;
                Log.d("PAN", "api req: " + method + " " + url
                    + (body != null && !body.isEmpty() ? " body=" + body : ""));
                try {
                    result = httpRequest(method, url, body, withAuth);
                } catch (Exception e) {
                    Log.e("PAN", "api fail: " + method + " " + url + " -> " + e, e);
                    result = "{\"ok\":false,\"error\":\"网络异常: " + json(e.getMessage()) + "\"}";
                }
                String logBody = result;
                if (logBody != null) {
                    // list 接口完整打印（供定位移动落盘），其余接口仍截断前 200
                    boolean isList = url != null && url.contains("file/list");
                    int cap = isList ? 8000 : 200;
                    if (logBody.length() > cap) logBody = logBody.substring(0, cap);
                }
                Log.d("PAN", "api resp: " + method + " " + url + " -> " + logBody);
                final String js = callback + "(" + result + ");";
                handler.post(new Runnable() {
                    @Override public void run() {
                        if (webView != null) webView.evaluateJavascript(js, null);
                    }
                });
            }
        });
    }

    /** 相册缩略图：下载缩略图转 base64 返回给前端 */
    void getThumbnailImpl(final String callback, final long fileId) {
        executor.execute(new Runnable() {
            @Override public void run() {
                String result = "";
                try {
                    String token = prefs.getString(KEY_TOKEN, "");
                    java.net.HttpURLConnection c = (java.net.HttpURLConnection)
                        new java.net.URL("https://api.123pan.cn/api/file/thumbnail?fileId=" + fileId).openConnection();
                    c.setConnectTimeout(10000);
                    c.setReadTimeout(10000);
                    c.setRequestProperty("authorization", "Bearer " + token);
                    c.setRequestProperty("platform", "web");
                    c.setRequestProperty("user-agent", "123pan/v2.4.0(" + osVersion + ";Xiaomi)");
                    int code = c.getResponseCode();
                    if (code == 200) {
                        java.io.InputStream is = c.getInputStream();
                        byte[] buf = new byte[8192];
                        java.io.ByteArrayOutputStream bos = new java.io.ByteArrayOutputStream();
                        int n;
                        while ((n = is.read(buf)) != -1) bos.write(buf, 0, n);
                        result = android.util.Base64.encodeToString(bos.toByteArray(), android.util.Base64.NO_WRAP);
                    }
                } catch (Exception e) {
                    Log.e("PAN", "thumb fail: " + fileId, e);
                }
                final String r = result;
                handler.post(new Runnable() {
                    @Override public void run() {
                        if (webView != null) webView.evaluateJavascript(callback + "('" + r + "');", null);
                    }
                });
            }
        });
    }

    /** 基础 HTTP 请求 */
    private String httpRequest(String method, String url, String body, boolean withAuth)
            throws IOException {
        HttpURLConnection conn = (HttpURLConnection) new URL(url).openConnection();
        conn.setConnectTimeout(15000);
        conn.setReadTimeout(url != null && url.contains("offline_download") ? 60000 : 20000);
        conn.setRequestMethod(method);
        // 复刻 123pan-open 的标准请求头
        String token = prefs.getString(KEY_TOKEN, "");
        conn.setRequestProperty("user-agent",
            "123pan/v2.4.0(" + osVersion + ";Xiaomi)");
        conn.setRequestProperty("authorization",
            withAuth && !token.isEmpty() ? "Bearer " + token : "");
        conn.setRequestProperty("osversion", osVersion);
        conn.setRequestProperty("loginuuid", loginuuid);
        // 关键：platform 必须是 "web"，否则服务端对上传走 android 分支，
        // 导致 complete 返回 code:0 但文件不真正落盘（Location 空 / 文件夹 Total:0）。
        conn.setRequestProperty("platform", "web");
        conn.setRequestProperty("devicetype", deviceType);
        conn.setRequestProperty("devicename", devicename);
        conn.setRequestProperty("app-version", "61");
        conn.setRequestProperty("x-app-version", "2.4.0");
        // 与官方 web 客户端保持一致的 Origin/Referer（配合 platform=web）
        conn.setRequestProperty("Origin", "https://yun.123pan.cn");
        conn.setRequestProperty("Referer", "https://yun.123pan.cn/");
        if (body != null && !body.isEmpty()) {
            conn.setDoOutput(true);
            conn.setRequestProperty("content-type", "application/json; charset=UTF-8");
            byte[] b = body.getBytes(StandardCharsets.UTF_8);
            OutputStream os = conn.getOutputStream();
            os.write(b);
            os.flush();
            os.close();
        }
        int code = conn.getResponseCode();
        // HttpURLConnection (API 19+) 在未手动设置 Accept-Encoding 时会自动发送
        // gzip 请求头并自动解压 gzip 响应，故此处直接读取明文流即可，无需手动解压。
        InputStream is = code >= 400 ? conn.getErrorStream() : conn.getInputStream();
        BufferedReader r = new BufferedReader(
            new InputStreamReader(is == null ? (InputStream) null : is, StandardCharsets.UTF_8));
        StringBuilder sb = new StringBuilder();
        String line;
        while ((line = r.readLine()) != null) sb.append(line);
        r.close();
        conn.disconnect();
        return sb.toString();
    }
    /**
     * 带自动重试的 API 请求：上传/下载长任务链路专用（网络瞬时抖动时自动恢复）。
     * 首次失败后按 800ms、1600ms…指数退避重试，最多 maxRetries 次；全部失败抛最后异常。
     * 仅用于 body 较小且幂等的 API 调用（如 upload_request / s3_repare / s3_list / upload_complete）。
     */
    private String httpRequestWithRetry(String method, String url, String body, boolean withAuth,
            int maxRetries) throws IOException {
        IOException last = null;
        for (int i = 0; i <= maxRetries; i++) {
            try {
                if (i > 0) {
                    long backoff = 800L * i;
                    try { Thread.sleep(backoff); } catch (InterruptedException ie) { break; }
                    Log.d("PAN", "httpRequest retry #" + i + " " + method + " " + url);
                }
                return httpRequest(method, url, body, withAuth);
            } catch (IOException e) {
                last = e;
                Log.w("PAN", "httpRequest fail (attempt " + (i + 1) + "/" + (maxRetries + 1)
                    + "): " + e + " url=" + url);
            }
        }
        throw last != null ? last : new IOException("请求失败: timeout");
    }

    // ============ 本地预览代理 ============
    // 背景：WebView 的 <img>/<audio>/<video>/pdf.js 无法携带认证头直连 123pan CDN 直链，
    // 这里在本机 127.0.0.1 上开一个随机端口的小型转发服务：
    //   - JS 侧用 bridge.getPreviewUrl(直链) 换取本地代理 URL；
    //   - 代理按原始直链做多级解析（resolveRealDownloadUrl），带全套认证头请求真实 CDN，
    //     并透传 Range / 206，从而支持音视频拖动与 pdf.js 分段加载。
    private java.net.ServerSocket previewSocket;
    private int previewPort = 0;
    private String previewKey = "";
    private final java.util.Map<String, String> previewResolvedCache =
        new java.util.concurrent.ConcurrentHashMap<>();

    private synchronized boolean ensurePreviewProxy() {
        if (previewSocket != null && !previewSocket.isClosed() && previewPort > 0) return true;
        try {
            java.net.ServerSocket ss = new java.net.ServerSocket(
                0, 24, java.net.InetAddress.getByName("127.0.0.1"));
            previewSocket = ss;
            previewPort = ss.getLocalPort();
            previewKey = UUID.randomUUID().toString().replace("-", "");
            Thread t = new Thread(new Runnable() {
                @Override public void run() {
                    while (true) {
                        try {
                            final java.net.Socket s = previewSocket.accept();
                            Thread ct = new Thread(new Runnable() {
                                @Override public void run() { handlePreviewConn(s); }
                            });
                            ct.setDaemon(true);
                            ct.start();
                        } catch (Exception e) {
                            break; // socket 关闭或致命错误：退出接受循环
                        }
                    }
                }
            });
            t.setDaemon(true);
            t.start();
            Log.d("PAN", "preview proxy started on 127.0.0.1:" + previewPort);
            return true;
        } catch (Exception e) {
            Log.e("PAN", "preview proxy start fail: " + e, e);
            previewSocket = null;
            previewPort = 0;
            previewKey = "";
            return false;
        }
    }

    /** 供 JS 桥调用：把下载直链包装成本地代理 URL（失败返回空串）。 */
    public String getPreviewUrl(String url) {
        if (url == null || url.isEmpty()) return "";
        if (!(url.startsWith("http://") || url.startsWith("https://"))) return "";
        if (!ensurePreviewProxy()) return "";
        try {
            return "http://127.0.0.1:" + previewPort + "/p/" + previewKey + "?u="
                + URLEncoder.encode(url, "UTF-8");
        } catch (Exception e) {
            return "";
        }
    }

    /** 解析（带缓存）：把 download-v2 中转等解析为最终 CDN 直链。 */
    private String resolvePreviewTarget(String url) {
        String real = previewResolvedCache.get(url);
        if (real != null && !real.isEmpty()) return real;
        real = resolveRealDownloadUrl(url, "preview");
        if (real != null && !real.isEmpty()) previewResolvedCache.put(url, real);
        return real;
    }

    /** 处理一个本地代理连接：解析请求 -> 解析直链 -> 带认证头转发 -> 透传状态/响应头/字节流。 */
    private void handlePreviewConn(java.net.Socket s) {
        java.io.OutputStream out = null;
        HttpURLConnection upstream = null;
        try {
            s.setSoTimeout(30000);
            java.io.InputStream sin = s.getInputStream();
            out = s.getOutputStream();
            java.io.BufferedReader r = new java.io.BufferedReader(
                new java.io.InputStreamReader(sin, "ISO-8859-1"));
            String reqLine = r.readLine();
            if (reqLine == null) return;
            String[] parts = reqLine.split(" ");
            String method = parts.length >= 1 ? parts[0] : "";
            String path = parts.length >= 2 ? parts[1] : "";
            String range = null;
            String line;
            int hn = 0;
            while ((line = r.readLine()) != null && !line.isEmpty() && hn++ < 60) {
                int c = line.indexOf(':');
                if (c > 0 && "range".equalsIgnoreCase(line.substring(0, c).trim())) {
                    range = line.substring(c + 1).trim();
                }
            }
            int qIdx = path.indexOf('?');
            String p0 = qIdx >= 0 ? path.substring(0, qIdx) : path;
            String query = qIdx >= 0 ? path.substring(qIdx + 1) : "";
            if (!p0.equals("/p/" + previewKey)) {
                writePreviewErr(out, 403, "forbidden");
                return;
            }
            String target = "";
            if (query.startsWith("u=")) {
                target = java.net.URLDecoder.decode(query.substring(2), "UTF-8");
            }
            if (!(target.startsWith("http://") || target.startsWith("https://"))) {
                writePreviewErr(out, 400, "bad target");
                return;
            }
            String real = resolvePreviewTarget(target);
            if (real == null || real.isEmpty()) {
                writePreviewErr(out, 502, "resolve failed");
                return;
            }
            upstream = (HttpURLConnection) new URL(real).openConnection();
            upstream.setConnectTimeout(20000);
            upstream.setReadTimeout(120000);
            upstream.setRequestMethod("GET");
            upstream.setInstanceFollowRedirects(true);
            upstream.setRequestProperty("Accept-Encoding", "identity");
            String token = prefs.getString(KEY_TOKEN, "");
            upstream.setRequestProperty("user-agent", "123pan/v2.4.0(" + osVersion + ";Xiaomi)");
            upstream.setRequestProperty("authorization", token.isEmpty() ? "" : "Bearer " + token);
            upstream.setRequestProperty("osversion", osVersion);
            upstream.setRequestProperty("platform", "web");
            upstream.setRequestProperty("devicetype", deviceType);
            upstream.setRequestProperty("devicename", devicename);
            upstream.setRequestProperty("app-version", "61");
            upstream.setRequestProperty("x-app-version", "2.4.0");
            upstream.setRequestProperty("Origin", "https://yun.123pan.cn");
            upstream.setRequestProperty("Referer", "https://yun.123pan.cn/");
            if (range != null && !range.isEmpty()) {
                upstream.setRequestProperty("Range", range);
            }
            int code = upstream.getResponseCode();
            if (code >= 400) {
                Log.w("PAN", "preview upstream HTTP " + code + " for " + real);
                writePreviewErr(out, 502, "upstream HTTP " + code);
                return;
            }
            boolean is206 = code == 206;
            String ctype = upstream.getContentType();
            if (ctype == null || ctype.isEmpty()
                || ctype.toLowerCase().startsWith("application/octet-stream")) {
                ctype = guessPreviewType(real);
            }
            StringBuilder head = new StringBuilder();
            head.append("HTTP/1.1 ").append(is206 ? "206 Partial Content"
                : (code == 200 ? "200 OK" : code + " OK")).append("\r\n");
            head.append("Content-Type: ").append(ctype).append("\r\n");
            String cr = upstream.getHeaderField("Content-Range");
            if (cr != null) head.append("Content-Range: ").append(cr).append("\r\n");
            String cl = upstream.getHeaderField("Content-Length");
            if (cl != null) head.append("Content-Length: ").append(cl).append("\r\n");
            head.append("Accept-Ranges: bytes\r\n");
            head.append("Access-Control-Allow-Origin: *\r\n");
            head.append("Access-Control-Expose-Headers: Content-Range, Content-Length, Accept-Ranges\r\n");
            head.append("Cache-Control: no-store\r\n");
            head.append("Connection: close\r\n\r\n");
            out.write(head.toString().getBytes("ISO-8859-1"));
            if (!"HEAD".equalsIgnoreCase(method)) {
                InputStream uin = upstream.getInputStream();
                byte[] buf = new byte[65536];
                int n;
                while ((n = uin.read(buf)) > 0) {
                    out.write(buf, 0, n);
                }
                uin.close();
            }
            out.flush();
        } catch (Exception e) {
            // 播放器拖动/关闭时主动断开属正常现象，仅记录
            Log.d("PAN", "preview conn end: " + e);
        } finally {
            try { if (upstream != null) upstream.disconnect(); } catch (Exception ignore) {}
            try { if (out != null) out.close(); } catch (Exception ignore) {}
            try { s.close(); } catch (Exception ignore) {}
        }
    }

    /** 代理错误响应（小体积文本）。 */
    private void writePreviewErr(java.io.OutputStream out, int code, String msg) {
        try {
            byte[] b = ("preview proxy error: " + msg).getBytes("UTF-8");
            String h = "HTTP/1.1 " + code + " Error\r\n"
                + "Content-Type: text/plain; charset=utf-8\r\n"
                + "Content-Length: " + b.length + "\r\n"
                + "Cache-Control: no-store\r\n"
                + "Connection: close\r\n\r\n";
            out.write(h.getBytes("ISO-8859-1"));
            out.write(b);
            out.flush();
        } catch (Exception ignore) {}
    }

    /** 依据扩展名猜测 Content-Type（CDN 返回 octet-stream 或缺失时兜底）。 */
    private String guessPreviewType(String url) {
        String u = url == null ? "" : url.toLowerCase();
        int q = u.indexOf('?');
        if (q >= 0) u = u.substring(0, q);
        if (u.endsWith(".jpg") || u.endsWith(".jpeg")) return "image/jpeg";
        if (u.endsWith(".png")) return "image/png";
        if (u.endsWith(".gif")) return "image/gif";
        if (u.endsWith(".webp")) return "image/webp";
        if (u.endsWith(".bmp")) return "image/bmp";
        if (u.endsWith(".svg")) return "image/svg+xml";
        if (u.endsWith(".mp3")) return "audio/mpeg";
        if (u.endsWith(".m4a")) return "audio/mp4";
        if (u.endsWith(".wav")) return "audio/wav";
        if (u.endsWith(".flac")) return "audio/flac";
        if (u.endsWith(".aac")) return "audio/aac";
        if (u.endsWith(".ogg") || u.endsWith(".opus")) return "audio/ogg";
        if (u.endsWith(".mp4") || u.endsWith(".m4v")) return "video/mp4";
        if (u.endsWith(".webm")) return "video/webm";
        if (u.endsWith(".mov")) return "video/quicktime";
        if (u.endsWith(".mkv")) return "video/x-matroska";
        if (u.endsWith(".pdf")) return "application/pdf";
        if (u.endsWith(".txt")) return "text/plain; charset=utf-8";
        return "application/octet-stream";
    }

    /** 文本预览：原生拉取（带认证头），经 __onFetchText 回传（保留换行，超 1MB 截断）。 */
    public void fetchPreviewText(final String url) {
        final MainActivity act = this;
        new Thread(new Runnable() {
            @Override public void run() {
                boolean ok = false;
                String text = "";
                try {
                    String real = resolvePreviewTarget(url);
                    if (real == null || real.isEmpty()) throw new RuntimeException("resolve failed");
                    HttpURLConnection conn = (HttpURLConnection) new URL(real).openConnection();
                    conn.setConnectTimeout(15000);
                    conn.setReadTimeout(30000);
                    conn.setRequestMethod("GET");
                    conn.setInstanceFollowRedirects(true);
                    conn.setRequestProperty("Accept-Encoding", "identity");
                    String token = prefs.getString(KEY_TOKEN, "");
                    conn.setRequestProperty("user-agent", "123pan/v2.4.0(" + osVersion + ";Xiaomi)");
                    conn.setRequestProperty("authorization", token.isEmpty() ? "" : "Bearer " + token);
                    conn.setRequestProperty("osversion", osVersion);
                    conn.setRequestProperty("platform", "web");
                    conn.setRequestProperty("devicetype", deviceType);
                    conn.setRequestProperty("devicename", devicename);
                    conn.setRequestProperty("app-version", "61");
                    conn.setRequestProperty("x-app-version", "2.4.0");
                    conn.setRequestProperty("Origin", "https://yun.123pan.cn");
                    conn.setRequestProperty("Referer", "https://yun.123pan.cn/");
                    int code = conn.getResponseCode();
                    if (code < 200 || code >= 400) throw new RuntimeException("HTTP " + code);
                    InputStream is = wrapMaybeGzip(conn, conn.getInputStream());
                    final int LIMIT = 1024 * 1024;
                    java.io.ByteArrayOutputStream bo = new java.io.ByteArrayOutputStream();
                    byte[] buf = new byte[16384];
                    int n;
                    int total = 0;
                    boolean truncated = false;
                    while ((n = is.read(buf)) > 0) {
                        int w = Math.min(n, LIMIT - total);
                        if (w > 0) bo.write(buf, 0, w);
                        total += w;
                        if (total >= LIMIT) {
                            // 再读一个字节判断是否还有剩余
                            if (is.read() >= 0) truncated = true;
                            break;
                        }
                    }
                    is.close();
                    conn.disconnect();
                    text = new String(bo.toByteArray(), "UTF-8");
                    if (truncated) text += "\n\n……（内容过大，仅显示前 1 MB）";
                    ok = true;
                } catch (Exception e) {
                    ok = false;
                    text = "";
                    Log.w("PAN", "fetchPreviewText fail: " + e);
                }
                final boolean fok = ok;
                final String ftxt = text;
                final String js = "window.__onFetchText && window.__onFetchText("
                    + org.json.JSONObject.quote(url) + "," + fok + ","
                    + org.json.JSONObject.quote(ftxt) + ");";
                act.handler.post(new Runnable() {
                    @Override public void run() {
                        if (act.webView != null) act.webView.evaluateJavascript(js, null);
                    }
                });
            }
        }).start();
    }

    /** 字节预览（Word/Excel/PDF 兼容模式）：原生拉取，Base64 经 __onFetchBytes 回传（上限 24MB）。 */
    public void fetchPreviewBytes(final String url) {
        final MainActivity act = this;
        new Thread(new Runnable() {
            @Override public void run() {
                boolean ok = false;
                String b64 = "";
                String msg = "";
                try {
                    String real = resolvePreviewTarget(url);
                    if (real == null || real.isEmpty()) throw new RuntimeException("获取直链失败");
                    HttpURLConnection conn = (HttpURLConnection) new URL(real).openConnection();
                    conn.setConnectTimeout(15000);
                    conn.setReadTimeout(60000);
                    conn.setRequestMethod("GET");
                    conn.setInstanceFollowRedirects(true);
                    conn.setRequestProperty("Accept-Encoding", "identity");
                    String token = prefs.getString(KEY_TOKEN, "");
                    conn.setRequestProperty("user-agent", "123pan/v2.4.0(" + osVersion + ";Xiaomi)");
                    conn.setRequestProperty("authorization", token.isEmpty() ? "" : "Bearer " + token);
                    conn.setRequestProperty("osversion", osVersion);
                    conn.setRequestProperty("platform", "web");
                    conn.setRequestProperty("devicetype", deviceType);
                    conn.setRequestProperty("devicename", devicename);
                    conn.setRequestProperty("app-version", "61");
                    conn.setRequestProperty("x-app-version", "2.4.0");
                    conn.setRequestProperty("Origin", "https://yun.123pan.cn");
                    conn.setRequestProperty("Referer", "https://yun.123pan.cn/");
                    int code = conn.getResponseCode();
                    if (code < 200 || code >= 400) throw new RuntimeException("HTTP " + code);
                    InputStream is = wrapMaybeGzip(conn, conn.getInputStream());
                    final int LIMIT = 24 * 1024 * 1024;
                    java.io.ByteArrayOutputStream bo = new java.io.ByteArrayOutputStream();
                    byte[] buf = new byte[65536];
                    int n;
                    int total = 0;
                    boolean over = false;
                    while ((n = is.read(buf)) > 0) {
                        if (total + n > LIMIT) { over = true; break; }
                        bo.write(buf, 0, n);
                        total += n;
                    }
                    is.close();
                    conn.disconnect();
                    if (over) throw new RuntimeException("文件过大（超过 24 MB），请下载后查看");
                    b64 = android.util.Base64.encodeToString(bo.toByteArray(), android.util.Base64.NO_WRAP);
                    ok = true;
                } catch (Exception e) {
                    ok = false;
                    msg = e.getMessage() == null ? "加载失败" : e.getMessage();
                    Log.w("PAN", "fetchPreviewBytes fail: " + e);
                }
                final boolean fok = ok;
                final String fb64 = b64;
                final String fmsg = msg;
                final String js = "window.__onFetchBytes && window.__onFetchBytes("
                    + org.json.JSONObject.quote(url) + "," + fok + ","
                    + org.json.JSONObject.quote(fb64) + ","
                    + org.json.JSONObject.quote(fmsg) + ");";
                act.handler.post(new Runnable() {
                    @Override public void run() {
                        if (act.webView != null) act.webView.evaluateJavascript(js, null);
                    }
                });
            }
        }).start();
    }

    /** 若服务端仍返回 gzip，则包装解压流（请求头已声明 identity）。 */
    private static InputStream wrapMaybeGzip(HttpURLConnection c, InputStream is) {
        try {
            String enc = c.getContentEncoding();
            if (enc != null && enc.toLowerCase().contains("gzip")) {
                return new GZIPInputStream(is);
            }
        } catch (Exception ignore) {}
        return is;
    }


    // ============ 上传 ============
    /** 计算文件 MD5（123pan 的 etag 用） */
    private static String md5File(File f) {
        try {
            MessageDigest md = MessageDigest.getInstance("MD5");
            FileInputStream in = new FileInputStream(f);
            byte[] buf = new byte[65536];
            int n;
            while ((n = in.read(buf)) > 0) md.update(buf, 0, n);
            in.close();
            StringBuilder sb = new StringBuilder();
            for (byte b : md.digest()) {
                sb.append(String.format("%02x", b & 0xff));
            }
            return sb.toString();
        } catch (Exception e) {
            Log.e("PAN", "md5 fail: " + e);
            return "";
        }
    }

    /**
     * 原生上传单文件，完整走 123pan 流程：
     *  1) POST file/upload_request  获取预签名上传信息
     *  2) 据返回上传文件字节
     *  3) 结束/确认（如需要）
     * 结果通过 window.__onUploadResult(id,ok,msg) 回传前端（进度：window.__onUploadProgress(id,done,total)）。
     */
    // 创建上传任务并立即返回任务 id（供上传队列管理 / 取消）；实际上传在后台线程执行
    private long uploadFile(final String localPath, final long parentFileId) {
        final UpTask ut = new UpTask();
        ut.id = nextUpId++;
        ut.localPath = localPath;
        ut.parentFileId = parentFileId;
        ut.status = 1;
        upTasks.put(ut.id, ut);
        logDl("upload enqueue id=" + ut.id + " file=" + localPath + " parent=" + parentFileId);
        executor.execute(new Runnable() {
            @Override public void run() {
                String ok = "false", msg = "";
                if (ut.cancelled) { ut.status = 2; fireUploadResult(ut, false, "已取消上传"); return; }
                try {
                    File f = new File(localPath);
                    if (!f.exists() || !f.isFile()) {
                        msg = "本地文件不可读：" + localPath;
                    } else {
                        long size = f.length();
                        String etag = md5File(f);
                        String fname = f.getName();
                        Log.d("PAN", "upload start: " + fname + " size=" + size + " etag=" + etag
                            + " parent=" + parentFileId);

                        String token = prefs.getString(KEY_TOKEN, "");
                        final String API = "https://api.123pan.cn";
                        StringBuilder log = new StringBuilder();
                        log.append("==== ").append(new java.util.Date()).append(" ====\nfile=").append(fname)
                          .append(" size=").append(size).append(" etag=").append(etag)
                          .append(" parent=").append(parentFileId)
                          .append(" token=").append(token.isEmpty() ? "(EMPTY)" : "(has)").append("\n");

                        // ============ 1) upload_request：获取上传任务 ============
                        // 根因：字段名必须为 fileName（大写N），否则 400 参数校验失败。
                        // 协议来自开源 123pan-uploader-cli（OlyMarco/123pan-uploader-cli）。
                        String upBody = "{\"driveId\":0,\"fileName\":\"" + json(fname)
                            + "\",\"etag\":\"" + etag
                            + "\",\"size\":" + size
                            + ",\"parentFileId\":" + parentFileId
                            + ",\"type\":0"
                            + ",\"duplicate\":1}";
                        Log.d("PAN", "[1]upload_request req body=" + upBody);
                        Log.d("PAN", "[1]DEBUG token=" + token);
                        String upResp = httpRequestWithRetry("POST", API + "/b/api/file/upload_request", upBody, true, 2);
                        Log.d("PAN", "[1]upload_request resp=" + upResp);
                        log.append("[1]upload_request: ").append(upResp).append("\n");
                        org.json.JSONObject upJson = new org.json.JSONObject(upResp);
                        if (upJson.optInt("code", -1) != 0) {
                            msg = "upload_request 失败: " + upJson.optString("message");
                            throw new IOException(msg);
                        }
                        org.json.JSONObject upData = upJson.getJSONObject("data");
                        String bucket = upData.optString("Bucket");
                        String storageNode = upData.optString("StorageNode");
                        String uploadKey = upData.optString("Key");
                        String uploadId = upData.optString("UploadId");
                        long fileId = upData.optLong("FileId", 0);
                        long sliceSize = upData.optLong("SliceSize", 5L * 1024 * 1024);
                        boolean reuse = upData.optBoolean("Reuse", false);
                        int uploadFileStatus = upData.optInt("UploadFileStatus", 0);
                        org.json.JSONObject reuseInfo = upData.optJSONObject("Info");
                        log.append("  bucket=").append(bucket).append(" node=").append(storageNode)
                           .append(" key=").append(uploadKey).append(" uploadId=").append(uploadId)
                           .append(" fileId=").append(fileId).append(" slice=").append(sliceSize)
                           .append(" reuse=").append(reuse).append(" status=").append(uploadFileStatus)
                           .append(" info=").append(reuseInfo == null ? "(none)"
                               : ("fileId=" + reuseInfo.optLong("FileId", 0))).append("\n");

                        // 【2026-09-16 根因修复】秒传（Reuse）仅在服务端同时返回 Info 落盘证明时才可信：
                        //   - 官方 Web 上传引擎（生产包 module 38709）：仅当 `Reuse && Info` 才按秒传完成，
                        //     否则按真实上传继续（不复用声明）；
                        //   - rclone-123pan 实测：`Reuse=true` 且无 Info / FileId=0 时，
                        //     文件往往并未真正出现在目标目录，盲目报成功即"假成功"。
                        if (reuse && reuseInfo != null && reuseInfo.optLong("FileId", 0) > 0) {
                            msg = "上传成功（云端已有相同内容，已秒传复用，fileId="
                                + reuseInfo.optLong("FileId", 0) + "）";
                            ok = "true";
                            throw new StopUpload(msg);
                        }
                        if (reuse) {
                            // Reuse 未被落盘证明：先核验父目录中是否真能查到该对象（对齐 rclone inspectUpload），
                            // 查得到按成功处理；查不到则降级为真实上传，绝不直接报成功。
                            log.append("[1] warn: Reuse=true 但无 Info 落盘证明，先核验父目录\n");
                            Log.d("PAN", "reuse without Info -> verify visible in parent");
                            org.json.JSONObject visible = findVisibleUploadedFile(parentFileId, fname, size, etag, fileId);
                            if (visible != null) {
                                long vid = visible.optLong("FileId", fileId);
                                msg = "上传成功（云端已有相同内容，已秒传复用，fileId=" + vid + "）";
                                ok = "true";
                                throw new StopUpload(msg);
                            }
                            log.append("[1] warn: 父目录未见落盘对象，降级真实上传\n");
                            Log.d("PAN", "reuse without Info and not visible -> real upload");
                        }
                        if (uploadKey.isEmpty()) {
                            // 无 Key 无法进行任何真实上传/预签名，且秒传未被证实：失败关闭，绝不假报成功
                            throw new IOException("upload_request 未返回上传会话（Key 为空），本次未上传，请重试");
                        }
                        // ============ 2B) 大文件：分片上传（multipart，支持断点续传）============
                        // 协议对齐官方 Web 生产包（2026-09-16 抓包核对）：
                        //   upload_request -> s3_list_upload_parts(初始化/查已传分片)
                        //   -> s3_repare_upload_parts_batch -> PUT(part)
                        //   -> s3_list_upload_parts(确认) -> upload_complete/v2 ->（必要时）轮询 upload_complete/result
                        // 说明：s3_complete_multipart_upload 与 upload_complete(v1) 均已被官方废弃
                        //（后者在官方生产包中出现 0 次），继续调用会返回 code:0 但不真正归档——
                        // 这正是"假成功"的根因之一，已整体替换为 /v2 + 轮询确认落盘。
                        if (size >= UPLOAD_SLICE_THRESHOLD) {
                            try {
                                msg = runMultipartUpload(ut, f, size, etag, fname, parentFileId,
                                    bucket, storageNode, uploadKey, uploadId, fileId, sliceSize, uploadFileStatus, log);
                                ok = "true";
                                throw new StopUpload(msg);
                            } catch (MultipartFallback mf) {
                                // 仅在"未开始传输任何分片数据"的早期失败时回退整对象直传；
                                // 大文件（>64MB）无法整读内存，直接报错让用户重试（继续走断点续传）。
                                if (size > UPLOAD_FALLBACK_MAX) {
                                    throw new IOException("分片上传初始化失败：" + mf.getMessage());
                                }
                                log.append("[mp] 初始化失败，回退整对象直传：").append(mf.getMessage()).append("\n");
                                Log.d("PAN", "multipart fallback: " + mf.getMessage());
                            }
                        }
                        // ============ 2) 整对象直传（官方 Web 路径，决定性修复）============
                        // 【2026-09-14 更新】分片路径已在 2B 分支修复启用（补上初始化调用）：>=5MB 文件走分片，支持断点续传；本整对象路径用于 <5MB 小文件及分片初始化失败回退。
                        // 根因（2026-08-31，Median Browser 抓包 + curl 复现确认）：
                        // App 此前实现的是"分片上传"路径
                        //   (upload_request -> s3_list_upload_parts 初始化 -> s3_repare_upload_parts_batch
                        //    -> PUT(UploadPart) -> list_parts -> s3_complete_multipart_upload -> upload_complete)。
                        // 但该分片路径在当前 123 云盘服务端仅返回 code:0（Location 空、文件不归档），
                        // 造成"提示上传成功但文件未落盘"的经典假成功。
                        // 官方 Web 端小文件实际走"整对象直传"路径，已实测真实落盘：
                        //   upload_request -> s3_upload_object/auth(整对象鉴权拿预签名PUT)
                        //   -> PUT(整对象, x-id=PutObject) -> upload_complete/v2(完成归档)
                        // 详见 /tmp/pan_whole_123pan_cn.sh 的可复现验证。
                        byte[] all = readBytes(f);
                        log.append("[2]whole-object size=").append(all.length)
                           .append(" key=").append(uploadKey).append(" bucket=").append(bucket).append("\n");

                        // 2a) 整对象上传鉴权：获取该对象的预签名 PUT URL（x-id=PutObject）
                        // 请求体精确对齐官方 Web（2026-08-31 hook 抓包权威确认）：
                        //   {bucket,key,partNumberStart:1,partNumberEnd:2,uploadId,StorageNode}
                        // 注：必须用小写 bucket/key/uploadId + 大写 StorageNode；
                        // 之前用大写 {Key,Bucket,FileId,...} 虽然偶发能返回 preSigned，
                        // 但非官方格式，故统一改为官方字段命名。
                        String authBody = "{\"bucket\":\"" + bucket
                            + "\",\"key\":\"" + uploadKey
                            + "\",\"partNumberStart\":1"
                            + ",\"partNumberEnd\":2"
                            + ",\"uploadId\":\"" + uploadId
                            + "\",\"StorageNode\":\"" + storageNode + "\"}";
                        Log.d("PAN", "[2]s3_upload_object/auth req body=" + authBody);
                        String authResp = httpRequestWithRetry("POST",
                            API + "/b/api/file/s3_upload_object/auth", authBody, true, 2);
                        Log.d("PAN", "[2]s3_upload_object/auth resp=" + authResp);
                        log.append("[2]s3_upload_object/auth: ").append(authResp).append("\n");
                        org.json.JSONObject authJson = new org.json.JSONObject(authResp);
                        if (authJson.optInt("code", -1) != 0) {
                            msg = "整对象上传鉴权失败: " + authJson.optString("message");
                            throw new IOException(msg);
                        }
                        org.json.JSONObject presigned = authJson.getJSONObject("data")
                            .getJSONObject("presignedUrls");
                        String putUrl = presigned.optString("1");
                        if (putUrl.isEmpty()) {
                            // 兼容 presignedUrls 只含单个键（非 "1"）的情况
                            java.util.Iterator<String> itu = presigned.keys();
                            while (itu.hasNext()) putUrl = presigned.optString(itu.next());
                        }
                        if (putUrl.isEmpty()) {
                            msg = "整对象预签名 URL 为空";
                            throw new IOException(msg);
                        }
                        log.append("[2]presigned PUT url=").append(putUrl).append("\n");

                        // 2b) PUT 整个对象到预签名 URL（x-id=PutObject 整对象直传）
                        // 与官方 Web 一致：整对象一次性 PUT，request body 即文件全部字节。
                        // 分块写入并逐块上报进度到前端（window[callback](done,total)），实现上传进度条。
                        HttpURLConnection put = (HttpURLConnection) new URL(putUrl).openConnection();
                        put.setConnectTimeout(30000);
                        put.setReadTimeout(120000);
                        put.setRequestMethod("PUT");
                        put.setDoOutput(true);
                        put.setFixedLengthStreamingMode(all.length);
                        java.io.OutputStream pos = put.getOutputStream();
                        final int totalLen = all.length; // byte[] 长度即 int，与 Math.min/setFixedLengthStreamingMode 保持一致，避免 long→int lossy
                        final int upChunk = 262144; // 256KB，兼顾真实进度反馈与无谓回调开销
                        int sent = 0;
                        while (sent < totalLen) {
                            if (ut.cancelled) { // 用户取消：关闭输出流并中止上传
                                try { pos.close(); } catch (Exception ignore) {}
                                throw new StopUpload("已取消上传");
                            }
                            int len = Math.min(upChunk, totalLen - sent);
                            pos.write(all, sent, len);
                            sent += len;
                            final int fdone = sent;
                            // 进度回调需在 UI 线程执行（操作 WebView）；同时更新任务表进度（供队列展示）
                            ut.done = fdone;
                            ut.total = totalLen;
                            handler.post(new Runnable() {
                                @Override public void run() {
                                    if (webView != null) {
                                        webView.evaluateJavascript(
                                            "window.__onUploadProgress&&window.__onUploadProgress("
                                            + ut.id + "," + fdone + "," + totalLen + ");", null);
                                    }
                                }
                            });
                        }
                        pos.flush();
                        pos.close();
                        int putCode = put.getResponseCode();
                        log.append("[2]PUT(whole) status=").append(putCode);
                        java.io.InputStream pis = putCode >= 400
                            ? put.getErrorStream() : put.getInputStream();
                        if (pis != null) {
                            log.append(" resp=").append(readText(pis));
                            pis.close();
                        }
                        log.append("\n");
                        if (putCode < 200 || putCode >= 300) {
                            msg = "整对象上传失败 HTTP " + putCode;
                            throw new IOException(msg);
                        }
                        Log.d("PAN", "upload object done (" + putCode + ")");

                        // 2c) 完成归档（官方现行协议 upload_complete/v2；无 file_info 时轮询 result，绝不假成功）
                        //   body: {fileId, bucket, fileSize, key, isMultipart:false, uploadId, StorageNode}
                        //   isMultipart:false 标记整对象直传（而非分片）；对齐官方 Web module 38709 与 rclone 实测。
                        org.json.JSONObject closeJson = completeUploadAndWait(bucket, uploadKey, uploadId, storageNode,
                            fileId, size, false, uploadFileStatus, ut, log, "whole");
                        org.json.JSONObject fin = closeJson.optJSONObject("data");
                        org.json.JSONObject fileInfo = fin == null ? null : fin.optJSONObject("file_info");
                        if (fileInfo == null) {
                            // 未拿到落盘证明：判定失败（此前会误报"上传成功"）
                            throw new IOException("归档未确认（file_info 缺失），文件可能未落盘，请重试");
                        }
                        long realFileId = fileInfo.optLong("FileId", fileId);
                        log.append("[3]归档 fileId=").append(realFileId)
                           .append(" name=").append(fileInfo.optString("FileName", fname))
                           .append(" parent=").append(fileInfo.optLong("ParentFileId", parentFileId))
                           .append("\n");
                        fileId = realFileId;

                        msg = "上传成功：" + fname + "（" + (size / 1024) + "KB, fileId=" + fileId + "）";
                        ok = "true";
                    }
                } catch (StopUpload su) {
                    // 成功提前终止（如秒传复用），ok 已置 true，保留成功消息
                    msg = su.getMessage();
                } catch (Exception e) {
                    Log.e("PAN", "upload fail: " + e, e);
                    msg = e.getMessage();
                }
                final String fmsg = msg, fok = ok;
                if (ut.cancelled && !"true".equals(fok)) { ut.status = 2; }
                else { ut.status = "true".equals(fok) ? 8 : 16; }
                logDl("upload#" + ut.id + " result ok=" + fok + " msg=" + fmsg);
                handler.post(new Runnable() {
                    @Override public void run() {
                        if (webView != null) {
                            webView.evaluateJavascript(
                                "window.__onUploadResult&&window.__onUploadResult(" + ut.id + "," + fok + ","
                                + org.json.JSONObject.quote(fmsg == null ? "" : fmsg) + ");", null);
                        }
                        if (!"false".equals(fok) || true) {
                            // 调试：上传在未完全打通时亦把响应打出来，便于核对协议
                            Log.d("PAN", "upload callback ok=" + fok + " msg=" + fmsg);
                        }
                    }
                });
            }
        });
        return ut.id;
    }

    /** 调起系统文件夹选择器（SAF 目录树），用于文件夹上传（保留目录结构） */
    public void pickFolder() {
        handler.post(new Runnable() {
            @Override public void run() {
                try {
                    Intent it = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
                    it.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                    startActivityForResult(it, FOLDER_PICK_REQUEST);
                } catch (Exception e) {
                    Log.e("PAN", "pickFolder fail: " + e, e);
                    toast("无法打开文件夹选择器");
                }
            }
        });
    }
    /** 调起系统文件夹选择器（SAF 目录树），用于选择下载子目录 */
    public void pickDownloadDir() {
        handler.post(new Runnable() {
            @Override public void run() {
                try {
                    Intent it = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
                    it.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                    startActivityForResult(it, DOWNLOAD_DIR_PICK_REQUEST);
                } catch (Exception e) {
                    Log.e("PAN", "pickDownloadDir fail: " + e, e);
                    toast("无法打开文件夹选择器");
                }
            }
        });
    }

    /** 取消上传任务（写循环在下一块边界检查 cancelled 退出） */
    public void cancelUploadTask(final long taskId) {
        UpTask t = upTasks.get(taskId);
        if (t == null) return;
        t.cancelled = true;
        if (t.status == 1) t.status = 2;
        logDl("upload#" + taskId + " cancel requested");
    }
    /** 向前端发送上传结果回调（统一收口；用于任务未真正开始即被取消等提前返回场景） */
    private void fireUploadResult(final UpTask ut, final boolean okf, final String msg) {
        final String fok = okf ? "true" : "false";
        handler.post(new Runnable() {
            @Override public void run() {
                if (webView != null) {
                    String jsonMsg = org.json.JSONObject.quote(msg == null ? "" : msg);
                    webView.evaluateJavascript(
                        "window.__onUploadResult&&window.__onUploadResult(" + ut.id + "," + fok + "," + jsonMsg + ");", null);
                }
            }
        });
    }

    // ============ 上传辅助方法 ============
    /** 成功时提前终止上传流程的控制流异常（带成功消息），不走错误 catch。 */
    static class StopUpload extends RuntimeException {
        StopUpload(String msg) { super(msg); }
    }
    /** 分片上传"早期失败"（尚未传输任何分片数据）：可安全回退整对象直传。 */
    static class MultipartFallback extends Exception {
        MultipartFallback(String msg) { super(msg); }
    }
    /**
     * 大文件分片上传（multipart）＋断点续传。
     * 流程：s3_list_upload_parts(初始化/查已传分片) -> 循环[s3_repare_upload_parts_batch -> PUT(part)]
     *    -> s3_list_upload_parts(确认) -> upload_complete/v2 ->（必要时）轮询 upload_complete/result。
     * 【2026-09-16 修复】收尾改用官方现行协议：POST upload_complete/v2（isMultipart:true，7 字段），
     * 响应无 file_info 时轮询 GET upload_complete/result 直至 file_info 出现；
     * 不再调用已废弃的 s3_complete_multipart_upload / upload_complete(v1)（"假成功"根因）。
     * 断点续传：
     *   1) 每次上传前先查已上传分片（s3_list_upload_parts 为权威来源），跳过已传分片；
     *   2) 若本次 upload_request 返回新 UploadId，但本地缓存有"同一文件+同一父目录"的旧会话，
     *      则探测旧会话是否仍有分片，有则切回旧会话继续（取消/失败/重启后重试均可续传）。
     * 仅在"未开始传输任何数据"前失败时抛 MultipartFallback（供调用方回退整对象）。
     */
    private String runMultipartUpload(UpTask ut, File f, long size, String etag, String fname,
            long parentFileId, String bucket, String storageNode, String uploadKey, String uploadId,
            long fileId, long sliceSize, int uploadFileStatus, StringBuilder log) throws Exception {
        final String API = "https://api.123pan.cn";
        if (sliceSize <= 0) sliceSize = 5L * 1024 * 1024;
        if (uploadId == null || uploadId.isEmpty()) throw new MultipartFallback("UploadId 为空");

        // ---------- 1) 会话选择（支持复用历史会话续传） ----------
        String useBucket = bucket, useNode = storageNode, useKey = uploadKey, useUploadId = uploadId;
        long useSlice = sliceSize;
        java.util.Set<Integer> uploaded = new java.util.HashSet<Integer>();
        boolean usedCached = false;
        // 会话缓存键：同父目录 + 同内容（etag）+ 同大小才可续传（避免跨目录串会话）
        String sessKey = "upsess_" + parentFileId + "_" + etag + "_" + size;
        String cachedJson = prefs.getString(sessKey, "");
        if (!cachedJson.isEmpty()) {
            try {
                org.json.JSONObject cs = new org.json.JSONObject(cachedJson);
                String cUp = cs.optString("uploadId", "");
                long cSlice = cs.optLong("sliceSize", 0);
                if (!cUp.isEmpty() && !cUp.equals(uploadId) && cSlice == sliceSize) {
                    org.json.JSONObject lr = listUploadParts(cs.optString("bucket", ""),
                        cs.optString("key", ""), cUp, cs.optString("storageNode", ""));
                    if (lr != null && lr.optInt("code", -1) == 0) {
                        java.util.Set<Integer> upC = parseUploadedParts(lr);
                        if (upC.isEmpty()) {
                            // 服务端未返回分片明细：退回本地记录的已传分片作为参考
                            org.json.JSONArray la = cs.optJSONArray("uploaded");
                            if (la != null) {
                                for (int i = 0; i < la.length(); i++) {
                                    int pn = la.optInt(i, 0);
                                    if (pn > 0) upC.add(pn);
                                }
                            }
                        }
                        if (!upC.isEmpty()) {
                            useBucket = cs.optString("bucket", bucket);
                            useKey = cs.optString("key", uploadKey);
                            useNode = cs.optString("storageNode", storageNode);
                            useUploadId = cUp;
                            uploaded = upC;
                            usedCached = true;
                            log.append("[mp] 复用历史会话续传 uploadId=").append(cUp)
                               .append(" parts=").append(upC.size()).append("\n");
                        }
                    }
                }
            } catch (Exception ignore) {}
        }
        if (!usedCached) {
            // 对当前会话执行初始化调用（协议必需）并查询已传分片
            org.json.JSONObject lr;
            try {
                lr = listUploadParts(bucket, uploadKey, uploadId, storageNode);
            } catch (Exception e) {
                throw new MultipartFallback("列表已传分片失败: " + e.getMessage());
            }
            if (lr == null || lr.optInt("code", -1) != 0) {
                throw new MultipartFallback("列表已传分片失败: "
                    + (lr == null ? "无响应" : lr.optString("message")));
            }
            uploaded = parseUploadedParts(lr);
            if (uploaded.isEmpty()) {
                // 服务端未返回分片明细时，仅当本地缓存会话与当前一致才采信本地记录
                try {
                    org.json.JSONObject cs = new org.json.JSONObject(cachedJson);
                    if (cs.optString("uploadId", "").equals(uploadId)) {
                        org.json.JSONArray la = cs.optJSONArray("uploaded");
                        if (la != null) {
                            for (int i = 0; i < la.length(); i++) {
                                int pn = la.optInt(i, 0);
                                if (pn > 0) uploaded.add(pn);
                            }
                        }
                    }
                } catch (Exception ignore) {}
            }
        }
        log.append("[mp] session uploadId=").append(useUploadId)
           .append(" slice=").append(useSlice)
           .append(" uploadedParts=").append(uploaded.size())
           .append(" cached=").append(usedCached).append("\n");
        // 持久化会话（无论新老），供取消/失败/重启后重试续传
        try {
            org.json.JSONObject save = new org.json.JSONObject();
            save.put("bucket", useBucket);
            save.put("key", useKey);
            save.put("uploadId", useUploadId);
            save.put("storageNode", useNode);
            save.put("sliceSize", useSlice);
            save.put("fileId", fileId);
            save.put("uploaded", new org.json.JSONArray(new java.util.ArrayList<Integer>(uploaded)));
            save.put("ts", System.currentTimeMillis());
            prefs.edit().putString(sessKey, save.toString()).apply();
        } catch (Exception ignore) {}

        long totalParts = (size + useSlice - 1) / useSlice;
        if (totalParts < 1) totalParts = 1;
        long uploadedBytes = 0;
        for (int pn : uploaded) {
            if (pn >= 1 && pn <= totalParts) {
                uploadedBytes += Math.min(useSlice, size - (long) (pn - 1) * useSlice);
            }
        }
        final int resumeParts = uploaded.size();
        ut.total = size;
        ut.done = uploadedBytes;
        if (resumeParts > 0) fireUploadResume(ut, uploadedBytes, size);
        fireUploadProgress(ut, uploadedBytes, size);

        // ---------- 2) 循环上传缺失分片 ----------
        boolean payloadStarted = false;
        byte[] buf = new byte[262144];
        java.io.RandomAccessFile raf = new java.io.RandomAccessFile(f, "r");
        try {
            for (int pi = 1; pi <= totalParts; pi++) {
                if (ut.cancelled) throw new StopUpload("已取消上传");
                if (uploaded.contains(pi)) continue;
                long start = (long) (pi - 1) * useSlice;
                long partLen = Math.min(useSlice, size - start);
                // 2a) 获取该分片预签名地址
                String prepBody = "{\"bucket\":\"" + useBucket + "\",\"key\":\"" + useKey
                    + "\",\"partNumberEnd\":" + (pi + 1)
                    + ",\"partNumberStart\":" + pi
                    + ",\"uploadId\":\"" + useUploadId + "\",\"StorageNode\":\"" + useNode + "\"}";
                String prepResp;
                try {
                    prepResp = httpRequestWithRetry("POST",
                        API + "/b/api/file/s3_repare_upload_parts_batch", prepBody, true, 2);
                } catch (IOException e) {
                    if (!payloadStarted && uploaded.isEmpty()) {
                        throw new MultipartFallback("获取分片地址失败: " + e.getMessage());
                    }
                    throw e;
                }
                org.json.JSONObject prepJson = new org.json.JSONObject(prepResp);
                if (prepJson.optInt("code", -1) != 0) {
                    if (!payloadStarted && uploaded.isEmpty()) {
                        throw new MultipartFallback("获取分片地址失败: " + prepJson.optString("message"));
                    }
                    throw new IOException("分片 " + pi + " 获取预签名地址失败: "
                        + prepJson.optString("message"));
                }
                String putUrl = prepJson.getJSONObject("data").getJSONObject("presignedUrls")
                    .optString(String.valueOf(pi));
                if (putUrl.isEmpty()) {
                    throw new IOException("分片 " + pi + " 预签名地址为空");
                }
                // 2b) PUT 分片（流式读取本地文件对应区间，256KB 分块检查取消并上报进度）；
                // 网络抖动导致 timeout/失败时自动重试（最多3次，退避1s/2s），全部失败才中断任务。
                boolean putOk = false;
                IOException putLastErr = null;
                for (int ptry = 0; ptry < 3 && !putOk; ptry++) {
                    if (ptry > 0) {
                        try { Thread.sleep(1000L * ptry); } catch (InterruptedException ie) {}
                        log.append("[mp.").append(pi).append("] PUT retry #").append(ptry).append("\n");
                    }
                    try {
                        raf.seek(start);
                        HttpURLConnection put = (HttpURLConnection) new URL(putUrl).openConnection();
                        put.setConnectTimeout(30000);
                        put.setReadTimeout(180000);
                        put.setRequestMethod("PUT");
                        put.setDoOutput(true);
                        put.setFixedLengthStreamingMode((int) partLen);
                        payloadStarted = true;
                        java.io.OutputStream pos = put.getOutputStream();
                        long sent = 0;
                        while (sent < partLen) {
                            if (ut.cancelled) {
                                try { pos.close(); } catch (Exception ignore) {}
                                throw new StopUpload("已取消上传");
                            }
                            int len = (int) Math.min((long) buf.length, partLen - sent);
                            int rn = raf.read(buf, 0, len);
                            if (rn <= 0) throw new IOException("读取本地文件失败");
                            pos.write(buf, 0, rn);
                            sent += rn;
                            fireUploadProgress(ut, uploadedBytes + sent, size);
                        }
                        pos.flush();
                        pos.close();
                        int putCode = put.getResponseCode();
                        log.append("[mp.").append(pi).append("] PUT status=").append(putCode).append("\n");
                        if (putCode < 200 || putCode >= 300) {
                            putLastErr = new IOException("HTTP " + putCode);
                            try { put.disconnect(); } catch (Exception ignore) {}
                            continue;
                        }
                        put.disconnect();
                        putOk = true;
                    } catch (IOException e) {
                        putLastErr = e;
                    }
                }
                if (!putOk) {
                    throw new IOException("分片 " + pi + " 上传失败（已重试3次）: "
                        + (putLastErr != null ? putLastErr.getMessage() : "未知"));
                }
                uploadedBytes += partLen;
                uploaded.add(pi);
                // 更新持久化的已传分片记录（服务端不返回明细时兜底）
                try {
                    org.json.JSONObject cs2 = new org.json.JSONObject(prefs.getString(sessKey, "{}"));
                    cs2.put("uploaded", new org.json.JSONArray(new java.util.ArrayList<Integer>(uploaded)));
                    prefs.edit().putString(sessKey, cs2.toString()).apply();
                } catch (Exception ignore) {}
                fireUploadProgress(ut, uploadedBytes, size);
                logDl("upload#" + ut.id + " part " + pi + "/" + totalParts + " ok");
            }
        } finally {
            try { raf.close(); } catch (Exception ignore) {}
        }

        // ---------- 3) 确认已上传分片 ----------
        org.json.JSONObject listRes = listUploadParts(useBucket, useKey, useUploadId, useNode);
        log.append("[mp] list_parts(final): ").append(listRes == null ? "()" : listRes.toString()).append("\n");
        if (listRes == null || listRes.optInt("code", -1) != 0) {
            throw new IOException("确认分片列表失败: "
                + (listRes == null ? "无响应" : listRes.optString("message")));
        }
        java.util.Set<Integer> finParts = parseUploadedParts(listRes);
        if (!finParts.isEmpty() && finParts.size() < totalParts) {
            log.append("[mp] warn: 服务端分片确认 ").append(finParts.size())
               .append("/").append(totalParts).append("\n");
        }

        // ---------- 4) 完成归档（官方现行协议：upload_complete/v2 + 必要时轮询 result） ----------
        // 【2026-09-16 根因修复】官方 Web 已完全不再调用 s3_complete_multipart_upload 与
        // upload_complete(v1)：分片 PUT 完成后直接 POST upload_complete/v2（isMultipart:true，7 字段），
        // 响应无 file_info 时轮询 GET upload_complete/result 直到文件真正落盘。
        // 旧的 v1 链路会返回 code:0 却不归档——"提示成功但文件不出现"的假成功根因。
        org.json.JSONObject finJson = completeUploadAndWait(useBucket, useKey, useUploadId, useNode,
            fileId, size, true, uploadFileStatus, ut, log, "mp");
        org.json.JSONObject finData = finJson.optJSONObject("data");
        org.json.JSONObject finInfo = finData == null ? null : finData.optJSONObject("file_info");
        if (finInfo == null) {
            throw new IOException("归档未确认（file_info 缺失），文件可能未落盘，请重试");
        }
        fileId = finInfo.optLong("FileId", fileId);
        log.append("[mp] archived fileId=").append(fileId)
           .append(" name=").append(finInfo.optString("FileName", fname))
           .append(" parent=").append(finInfo.optLong("ParentFileId", parentFileId)).append("\n");
        // 成功后清除会话缓存
        try { prefs.edit().remove(sessKey).apply(); } catch (Exception ignore) {}

        StringBuilder m = new StringBuilder();
        m.append("上传成功：").append(fname)
         .append("（").append(size / 1024).append("KB, 分片 ").append(totalParts).append(" 片");
        if (resumeParts > 0) m.append(", 断点续传跳过 ").append(resumeParts).append(" 片");
        m.append(", fileId=").append(fileId).append("）");
        return m.toString();
    }
    /** 调用 s3_list_upload_parts（小写 storageNode；解析失败返回 null）。 */
    private org.json.JSONObject listUploadParts(String bucket, String key, String uploadId,
            String storageNode) throws IOException {
        String body = "{\"bucket\":\"" + bucket + "\",\"key\":\"" + key
            + "\",\"uploadId\":\"" + uploadId + "\",\"storageNode\":\"" + storageNode + "\"}";
        String resp = httpRequestWithRetry("POST", "https://api.123pan.cn/b/api/file/s3_list_upload_parts", body, true, 2);
        try {
            return new org.json.JSONObject(resp);
        } catch (Exception e) {
            return null;
        }
    }
    /**
     * 完成归档并等待落盘证明（官方现行协议，2026-09-16 对齐官方 Web module 38709 与 rclone-123pan）。
     *   1) POST /b/api/file/upload_complete/v2，body：
     *      {StorageNode, bucket, fileId, fileSize, isMultipart, key, uploadId}；
     *   2) 响应 data.file_info 缺失（或 UploadFileStatus==255 时直接）进入轮询：
     *      GET /b/api/file/upload_complete/result（参数为同名 query），
     *      间隔取响应 data.duration 秒（默认 2s），直到 file_info 出现；
     *   3) 上限 15 分钟（与官方一致），期间可取消。
     * 返回带有效 file_info 的完整响应；任何超时/错误均抛异常——绝不"假成功"。
     */
    private org.json.JSONObject completeUploadAndWait(String bucket, String key, String uploadId,
            String storageNode, long fileId, long fileSize, boolean isMultipart,
            int uploadFileStatus, UpTask ut, StringBuilder log, String tag) throws Exception {
        final String API = "https://api.123pan.cn";
        org.json.JSONObject body = new org.json.JSONObject();
        try {
            body.put("StorageNode", storageNode);
            body.put("bucket", bucket);
            body.put("fileId", fileId);
            body.put("fileSize", fileSize);
            body.put("isMultipart", isMultipart);
            body.put("key", key);
            body.put("uploadId", uploadId);
        } catch (Exception e) {
            throw new IOException("构建归档请求失败: " + e.getMessage());
        }
        if (uploadFileStatus != 255) {
            String req = body.toString();
            Log.d("PAN", "[" + tag + "] upload_complete/v2 req=" + req);
            String resp = httpRequestWithRetry("POST", API + "/b/api/file/upload_complete/v2", req, true, 2);
            Log.d("PAN", "[" + tag + "] upload_complete/v2 resp=" + resp);
            log.append("[").append(tag).append("] upload_complete/v2: ").append(resp).append("\n");
            org.json.JSONObject rj = new org.json.JSONObject(resp);
            if (rj.optInt("code", -1) != 0) {
                throw new IOException("归档失败: " + rj.optString("message"));
            }
            if (hasFileInfo(rj)) return rj;
        } else {
            log.append("[").append(tag).append("] UploadFileStatus=255，跳过 complete 直接轮询\n");
        }
        // 轮询 upload_complete/result（GET；query 与 complete body 同参；duration 秒，默认 2s）
        String query = "StorageNode=" + urlenc(storageNode)
            + "&bucket=" + urlenc(bucket)
            + "&fileId=" + fileId
            + "&fileSize=" + fileSize
            + "&isMultipart=" + isMultipart
            + "&key=" + urlenc(key)
            + "&uploadId=" + urlenc(uploadId);
        long deadline = System.currentTimeMillis() + 900000L;
        long waitMs = 2000L;
        while (true) {
            if (ut != null && ut.cancelled) throw new StopUpload("已取消上传");
            if (System.currentTimeMillis() > deadline) {
                throw new IOException("归档结果确认超时，文件可能未落盘，请重试");
            }
            String resp;
            try {
                resp = httpRequest("GET", API + "/b/api/file/upload_complete/result?" + query, null, true);
            } catch (IOException e) {
                // 单次轮询失败（网络抖动）不中断任务：未到总时限则退避后继续轮询
                log.append("[").append(tag).append("] result poll transient fail: ")
                   .append(e.getMessage()).append("\n");
                if (System.currentTimeMillis() > deadline) {
                    throw new IOException("归档结果确认超时，文件可能未落盘，请重试");
                }
                Thread.sleep(1000);
                continue;
            }
            log.append("[").append(tag).append("] result poll: ").append(resp).append("\n");
            org.json.JSONObject rj = new org.json.JSONObject(resp);
            if (rj.optInt("code", -1) != 0) {
                throw new IOException("确认归档结果失败: " + rj.optString("message"));
            }
            if (hasFileInfo(rj)) return rj;
            org.json.JSONObject rd = rj.optJSONObject("data");
            double dur = rd == null ? 2.0 : rd.optDouble("duration", 2.0);
            if (dur > 0 && dur <= 86400) waitMs = (long) (dur * 1000);
            if (waitMs < 200) waitMs = 200;
            long slept = 0;
            while (slept < waitMs) { // 分段休眠：保证取消及时生效
                if (ut != null && ut.cancelled) throw new StopUpload("已取消上传");
                long st = Math.min(250L, waitMs - slept);
                Thread.sleep(st);
                slept += st;
            }
        }
    }
    /** 判断归档响应 data.file_info 是否有效（FileId>0）。 */
    private static boolean hasFileInfo(org.json.JSONObject rj) {
        org.json.JSONObject rd = rj.optJSONObject("data");
        if (rd == null) return false;
        org.json.JSONObject fi = rd.optJSONObject("file_info");
        return fi != null && fi.optLong("FileId", 0) > 0;
    }
    /** query 参数 URL 编码（失败返回空串，避免抛异常打断流程）。 */
    private static String urlenc(String s) {
        try {
            return java.net.URLEncoder.encode(s == null ? "" : s, "UTF-8");
        } catch (Exception e) {
            return "";
        }
    }
    /**
     * 核验上传对象是否已真实出现在父目录列表中（对齐 rclone inspectUpload 的落盘校验）。
     *   - fileId>0：按 FileId 精确命中，命中且 Type/Size 一致才算通过，否则不放过；
     *   - fileId==0：按名称扫描，要求唯一候选且 Size 匹配（Etag 可用时也须匹配），多个候选视为歧义。
     * 返回命中项，或 null（查不到/有歧义/请求失败）——调用方凭此决定是否降级真实上传。
     */
    private org.json.JSONObject findVisibleUploadedFile(long parentFileId, String fname,
            long size, String md5, long fileId) {
        try {
            String params = "driveId=0&limit=200&next=0&orderBy=file_id&orderDirection=desc"
                + "&parentFileId=" + parentFileId + "&trashed=false&Page=1&OnlyLookAbnormalFile=0";
            String resp = httpRequest("GET",
                "https://api.123pan.cn/b/api/file/list/new?" + params, null, true);
            org.json.JSONObject rj = new org.json.JSONObject(resp);
            if (rj.optInt("code", -1) != 0) return null;
            org.json.JSONObject rd = rj.optJSONObject("data");
            if (rd == null) return null;
            org.json.JSONArray arr = rd.optJSONArray("InfoList");
            if (arr == null) return null;
            org.json.JSONObject candidate = null;
            for (int i = 0; i < arr.length(); i++) {
                org.json.JSONObject it = arr.optJSONObject(i);
                if (it == null) continue;
                long id = it.optLong("FileId", 0);
                if (fileId > 0) {
                    if (id != fileId) continue;
                    long isz = it.optLong("Size", size);
                    if (it.optInt("Type", 0) == 0 && isz == size) return it;
                    return null; // FileId 命中但字段矛盾：不放过
                }
                if (!fname.equals(it.optString("FileName", ""))) continue;
                if (it.optInt("Type", 0) != 0) continue;
                if (it.optLong("Size", -1) != size) continue;
                String ietag = it.optString("Etag", it.optString("etag", ""));
                if (ietag != null && !ietag.isEmpty() && md5 != null && !md5.isEmpty()
                    && !ietag.equalsIgnoreCase(md5)) continue;
                if (candidate != null) return null; // 多个候选：歧义，放弃
                candidate = it;
            }
            return candidate;
        } catch (Exception e) {
            Log.d("PAN", "findVisibleUploadedFile fail: " + e);
            return null;
        }
    }
    /** 尽力解析 s3_list_upload_parts 响应中的已上传分片号（兼容多种字段命名；解析不到返回空集合）。 */
    private static java.util.Set<Integer> parseUploadedParts(org.json.JSONObject resp) {
        java.util.Set<Integer> set = new java.util.HashSet<Integer>();
        if (resp == null) return set;
        org.json.JSONObject data = resp.optJSONObject("data");
        if (data == null) return set;
        org.json.JSONArray arr = data.optJSONArray("Parts");
        if (arr == null) arr = data.optJSONArray("parts");
        if (arr == null) arr = data.optJSONArray("UploadedParts");
        if (arr == null) arr = data.optJSONArray("uploadedParts");
        if (arr == null) arr = data.optJSONArray("List");
        if (arr == null) arr = data.optJSONArray("files");
        if (arr == null) return set;
        for (int i = 0; i < arr.length(); i++) {
            Object o = arr.opt(i);
            if (o instanceof org.json.JSONObject) {
                org.json.JSONObject it = (org.json.JSONObject) o;
                int pn = it.optInt("PartNumber", it.optInt("partNumber", it.optInt("Part", 0)));
                if (pn > 0) set.add(pn);
            } else if (o instanceof Integer) {
                int pn = (Integer) o;
                if (pn > 0) set.add(pn);
            }
        }
        return set;
    }
    /** 向前端发送上传进度（UI 线程执行；同步任务表进度）。 */
    private void fireUploadProgress(final UpTask ut, final long done, final long total) {
        ut.done = done;
        ut.total = total;
        handler.post(new Runnable() {
            @Override public void run() {
                if (webView != null) {
                    webView.evaluateJavascript(
                        "window.__onUploadProgress&&window.__onUploadProgress("
                        + ut.id + "," + done + "," + total + ");", null);
                }
            }
        });
    }
    /** 向前端发送"断点续传已从历史进度继续"通知（done 为已跳过的已传字节数）。 */
    private void fireUploadResume(final UpTask ut, final long done, final long total) {
        handler.post(new Runnable() {
            @Override public void run() {
                if (webView != null) {
                    webView.evaluateJavascript(
                        "window.__onUploadResume&&window.__onUploadResume("
                        + ut.id + "," + done + "," + total + ");", null);
                }
            }
        });
    }

    /** 读取本地文件全部字节（整对象直传 / 分片初始化回退时使用；大文件走分片流式上传，不再整读）。 */
    private byte[] readBytes(File f) throws IOException {
        FileInputStream fis = new FileInputStream(f);
        try {
            byte[] buf = new byte[(int) f.length()];
            int off = 0, n;
            while (off < buf.length && (n = fis.read(buf, off, buf.length - off)) != -1) {
                off += n;
            }
            return buf;
        } finally {
            fis.close();
        }
    }

    /** 将响应流读取为文本（UTF-8），用于预签名上传的 PUT 响应体。 */
    private String readText(InputStream in) throws IOException {
        if (in == null) return "";
        BufferedReader r = new BufferedReader(new InputStreamReader(in, StandardCharsets.UTF_8));
        StringBuilder sb = new StringBuilder();
        String line;
        while ((line = r.readLine()) != null) sb.append(line);
        r.close();
        return sb.length() > 300 ? sb.substring(0, 300) : sb.toString();
    }

    // 计算应用缓存大小（cacheDir + filesDir + 外部缓存），返回字节数
    private long calcCacheSize() {
        long total = 0;
        try { total += dirSize(getCacheDir()); } catch (Exception ignored) {}
        try { total += dirSize(getFilesDir()); } catch (Exception ignored) {}
        try { total += dirSize(getExternalCacheDir()); } catch (Exception ignored) {}
        return total;
    }
    private long dirSize(File dir) {
        if (dir == null || !dir.exists()) return 0;
        long sum = 0;
        File[] fs = dir.listFiles();
        if (fs != null) {
            for (File f : fs) {
                if (f.isDirectory()) sum += dirSize(f);
                else sum += f.length();
            }
        }
        return sum;
    }
    // 清除应用缓存：WebView 缓存 + 应用私有缓存目录 + 外部缓存 + Cookie
    private void clearAppCache() {
        handler.post(new Runnable() {
            @Override public void run() {
                try { if (webView != null) webView.clearCache(true); } catch (Exception ignored) {}
                try { CookieManager.getInstance().removeAllCookies(null); } catch (Exception ignored) {}
            }
        });
        try { deleteDir(new File(getCacheDir(), "http")); } catch (Exception ignored) {}
        try { deleteChildren(getCacheDir()); } catch (Exception ignored) {}
        try { deleteDir(new File(getFilesDir(), "cache")); } catch (Exception ignored) {}
        try { deleteDir(new File(getFilesDir(), "app_webview")); } catch (Exception ignored) {}
        try { deleteChildren(getExternalCacheDir()); } catch (Exception ignored) {}
    }
    private void deleteChildren(File dir) {
        if (dir == null || !dir.exists()) return;
        File[] fs = dir.listFiles();
        if (fs != null) for (File f : fs) deleteDir(f);
    }
    private void deleteDir(File dir) {
        if (dir == null || !dir.exists()) return;
        if (dir.isDirectory()) {
            File[] fs = dir.listFiles();
            if (fs != null) for (File f : fs) deleteDir(f);
        }
        dir.delete();
    }

    // ============ 官方登录（主 WebView 直接显示官方登录页） ============

    /** 在官方登录页捕获 sso-token，成功则保存会话并切回本地 SPA 主界面。 */
    private void tryCaptureSsoTokenFromMain() {
        try {
            if (officialLoginDone) return;
            String sso = null;
            String[] domains = {
                "https://user.123pan.cn",
                "https://yun.123pan.cn",
                "https://www.123pan.cn",
                "https://123pan.cn"
            };
            for (String d : domains) {
                String cookies = CookieManager.getInstance().getCookie(d);
                if (cookies == null || cookies.isEmpty()) continue;
                for (String kv : cookies.split(";")) {
                    kv = kv.trim();
                    if (kv.startsWith("sso-token=")) { sso = kv.substring("sso-token=".length()); break; }
                }
                if (sso != null && !sso.isEmpty()) break;
            }
            if (sso == null || sso.isEmpty()) return;
            officialLoginDone = true;
            String username = extractUsernameFromSso(sso);
            prefs.edit()
                .putString(KEY_TOKEN, sso)
                .putString(KEY_USER, username)
                .putString("loginuuid", loginuuid)
                .apply();
            Log.d("PAN", "official login captured sso-token, user=" + username);
            // 切回本地 SPA 主界面；onPageFinished 会注入 __restoreSession 恢复会话
            handler.post(() -> {
                if (webView != null) {
                    webView.loadUrl("file:///android_asset/index.html");
                }
            });
        } catch (Exception e) {
            Log.e("PAN", "capture sso-token fail: " + e);
        }
    }

    /** 从 sso-token(JWT) 中提取 username（payload 段 base64url 解码后取 username 字段）。 */
    private String extractUsernameFromSso(String sso) {
        try {
            String[] parts = sso.split("\\.");
            if (parts.length >= 2) {
                String payload = parts[1];
                // base64url -> base64
                String b64 = payload.replace('-', '+').replace('_', '/');
                while (b64.length() % 4 != 0) b64 += "=";
                byte[] decoded = android.util.Base64.decode(b64, android.util.Base64.DEFAULT);
                String jsonStr = new String(decoded, java.nio.charset.StandardCharsets.UTF_8);
                // 简单提取 username 字段
                String key = "\"username\":\"";
                int idx = jsonStr.indexOf(key);
                if (idx >= 0) {
                    int start = idx + key.length();
                    int end = jsonStr.indexOf("\"", start);
                    if (end > start) return jsonStr.substring(start, end);
                }
            }
        } catch (Exception ignored) { }
        return "";
    }

    /** dp 换算为 px。 */
    private int dp(int v) {
        return Math.round(getResources().getDisplayMetrics().density * v);
    }

    // ============ JS 桥 ============
    static class NativeBridge {
        private final MainActivity act;
        NativeBridge(MainActivity a) { this.act = a; }

        @JavascriptInterface
        public void toast(final String msg) { act.toast(msg); }

        @JavascriptInterface
        public void setKeepScreenOn(boolean on) { act.setKeepScreenOn(on); }

        @JavascriptInterface
        public boolean isSystemDark() { return act.isSystemDark(); }

        @JavascriptInterface
        public String getDownloadSubDir() { return act.getDownloadSubDir(); }

        @JavascriptInterface
        public void setDownloadSubDir(String dir) { act.setDownloadSubDir(dir); }

        @JavascriptInterface
        public void pickDownloadDir() { act.pickDownloadDir(); }

        @JavascriptInterface
        public void deleteDownloadedFile(String fileName) { act.deleteDownloadedFile(fileName); }

        @JavascriptInterface
        public void apiRequest(final String callback, final String method,
                               final String url, final String body, final boolean withAuth) {
            act.doApi(callback, method, url, body, withAuth);
        }

        // 获取文件缩略图（相册用）：下载缩略图转 base64 返回
        @JavascriptInterface
        public void getThumbnail(final String callback, final long fileId) {
            act.getThumbnailImpl(callback, fileId);
        }

        @JavascriptInterface
        public void saveSession(final String token, final String user, final String pass) {
            act.prefs.edit()
                .putString(KEY_TOKEN, token)
                .putString(KEY_USER, user)
                .putString(KEY_PASS, pass)
                .putString("loginuuid", act.loginuuid)
                .apply();
        }

        @JavascriptInterface
        public String loadToken() {
            return act.prefs.getString(KEY_TOKEN, "");
        }

        @JavascriptInterface
        public void clearSession() {
            act.prefs.edit().remove(KEY_TOKEN).remove(KEY_USER).remove(KEY_PASS).apply();
        }

        // 退出当前账号：清除本地会话 + WebView 官方域 cookie（含 sso-token），并回到官方登录页
        @JavascriptInterface
        public void logout() {
            act.prefs.edit().remove(KEY_TOKEN).remove(KEY_USER).remove(KEY_PASS).apply();
            act.handler.post(() -> {
                if (act.webView != null) {
                    try {
                        android.webkit.CookieManager cm = android.webkit.CookieManager.getInstance();
                        cm.removeAllCookies(null);
                        cm.flush();
                    } catch (Exception ignored) {}
                    act.officialLoginDone = false;
                    act.webView.loadUrl(OFFICIAL_LOGIN_URL);
                }
            });
        }

        // 打开官方登录页（多账号"添加账号/切换账号"及登录页兜底共用）。
        // 关键：必须先清除 WebView 官方域 cookie（含 sso-token）再加载登录页——
        // 否则官方登录页 centerlogin 检测到已有登录态会自动重定向回已登录账号，
        // 导致"添加账号"时不显示登录表单而是直接进入已登录账号（多账号缺陷）。
        // 与 logout() 保持一致：removeAllCookies + flash 后再 loadUrl 官方登录页。
        @JavascriptInterface
        public void openOfficialLogin() {
            act.handler.post(() -> {
                if (act.webView != null) {
                    try {
                        android.webkit.CookieManager cm = android.webkit.CookieManager.getInstance();
                        cm.removeAllCookies(null);
                        cm.flush();
                    } catch (Exception ignored) {}
                    act.officialLoginDone = false;
                    act.webView.loadUrl(OFFICIAL_LOGIN_URL);
                }
            });
        }

        @JavascriptInterface
        public String getVersion() { return currentVersionName(act); }

        @JavascriptInterface
        public String getLoginuuid() { return act.loginuuid; }

        // 安全验证/网页端管理：在当前WebView打开指定URL，按返回键回App
        @JavascriptInterface
        public void openVerifyWeb() {
            act.handler.post(() -> {
                if (act.webView != null) {
                    act.verifyMode = true;
                    // 切换为桌面UA，访问网页版管理界面
                    act.webView.getSettings().setUserAgentString(
                        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36");
                    act.webView.loadUrl("https://canary-yun.123pan.cn/");
                }
            });
        }

        //自动更新：后台拉取 GitHub 最新 Release 信息，经 __onUpdateCheck 回传前端
        @JavascriptInterface
        public void checkUpdate() {
          final MainActivity a = act;
          new Thread(new Runnable() {
            @Override public void run() {
              String result = null;
              try {
                java.net.HttpURLConnection conn = (java.net.HttpURLConnection) new java.net.URL(
                    "https://api.github.com/repos/sillycats/123pan-mobile-app/releases/latest").openConnection();
                conn.setConnectTimeout(10000);
                conn.setReadTimeout(15000);
                conn.setRequestProperty("Accept", "application/vnd.github+json");
                conn.setRequestProperty("User-Agent", "123pan-mobile-app");
                int code = conn.getResponseCode();
                if (code != 200) throw new RuntimeException("HTTP " + code);
                java.io.InputStream is = conn.getInputStream();
                java.io.ByteArrayOutputStream bo = new java.io.ByteArrayOutputStream();
                byte[] buf = new byte[8192];
                int n;
                while ((n = is.read(buf)) > 0) bo.write(buf, 0, n);
                is.close();
                conn.disconnect();
                org.json.JSONObject rel = new org.json.JSONObject(bo.toString("UTF-8"));
                org.json.JSONObject out = new org.json.JSONObject();
                out.put("ok", true);
                out.put("tag", rel.optString("tag_name", ""));
                out.put("name", rel.optString("name", ""));
                out.put("current", currentVersionName(a));
                String url = "";
                long apkSize = 0;
                org.json.JSONArray assets = rel.optJSONArray("assets");
                if (assets != null && assets.length() > 0) {
                  // 优先取第一个 .apk 资产（不盲目取 [0]，防资产顺序变化导致取错文件）
                  org.json.JSONObject pick = assets.getJSONObject(0);
                  for (int ai = 0; ai < assets.length(); ai++) {
                    org.json.JSONObject aobj = assets.getJSONObject(ai);
                    String an = aobj.optString("name", "");
                    if (an.toLowerCase().endsWith(".apk")) { pick = aobj; break; }
                  }
                  url = pick.optString("browser_download_url", "");
                  apkSize = pick.optLong("size", 0);
                }
                out.put("url", url);
                out.put("size", apkSize);
                result = out.toString();
              } catch (Exception e) {
                try {
                  org.json.JSONObject err = new org.json.JSONObject();
                  err.put("ok", false);
                  err.put("message", e.getMessage() == null ? "network error" : e.getMessage());
                  result = err.toString();
                } catch (Exception e2) {
                  result = "{}";
                }
              }
              final String js = "window.__onUpdateCheck && window.__onUpdateCheck(" + result + ");";
              a.handler.post(new Runnable() {
                @Override public void run() {
                  if (a.webView != null) a.webView.evaluateJavascript(js, null);
                }
              });
            }
          }).start();
        }
        
        //读取当前安装包版本名（versionName），供自动更新比对
        private String currentVersionName(MainActivity a) {
          try {
            android.content.pm.PackageInfo pi = a.getPackageManager().getPackageInfo(a.getPackageName(), 0);
            return pi.versionName == null ? "1.0.0" : pi.versionName;
          } catch (Exception e) {
            return "1.0.0";
          }
        }


        @JavascriptInterface
        public long download(final String url, final String filename) {
            // @JavascriptInterface 方法在 UI 线程调用，同步发起下载即可返回真实 id
            return act.downloadViaManager(url, filename);
        }

        // 自研流式下载（带认证头 + 严格字节校验），返回任务 id（>=900000000；失败 -1）
        @JavascriptInterface
        public long downloadStream(final String url, final String filename, final long expectedSize) {
            return act.downloadStream(url, filename, expectedSize);
        }
        // 自研流式下载任务控制：暂停 / 继续 / 重试 / 删除（2026-09 新增）
        @JavascriptInterface
        public void pauseDownload(final long taskId) { act.pauseDownload(taskId); }
        @JavascriptInterface
        public void resumeDownload(final long taskId) { act.resumeDownload(taskId); }
        @JavascriptInterface
        public void retryDownload(final long taskId) { act.retryDownload(taskId); }
        @JavascriptInterface
        public void deleteDownloadTask(final long taskId) { act.deleteDownloadTask(taskId); }

        // 自研流式下载任务进度
        @JavascriptInterface
        public String streamingTasks() {
            return act.streamingTasksJson();
        }

        @JavascriptInterface
        public String queryDownloads() {
            return act.queryDownloadsJson();
        }

        @JavascriptInterface
        // 上传任务（队列化）：创建任务并返回任务 id（>=800000000；失败 -1）
        public long uploadFileTask(final String localPath, final long parentFileId) {
            try { return act.uploadFile(localPath, parentFileId); }
            catch (Exception e) { return -1; }
        }
        @JavascriptInterface
        public void cancelUploadTask(final long taskId) { act.cancelUploadTask(taskId); }
        // 文件夹选择（SAF 目录树；用户选择后由原生遍历并回传文件列表）
        @JavascriptInterface
        public void pickFolder() { act.pickFolder(); }

        @JavascriptInterface
        public void openFile(final String name) {
            act.openDownloadedFile(name);
        }

        @JavascriptInterface
        public void exitApp() {
            act.handler.post(new Runnable() {
                @Override public void run() {
                    act.finish();
                }
            });
        }

        @JavascriptInterface
        public long getCacheSize() { return act.calcCacheSize(); }

        @JavascriptInterface
        public void clearCache() { act.clearAppCache(); }

        // 文件预览：本地媒体/PDF 代理 URL（带认证头转发直链、支持 Range）
        @JavascriptInterface public String getPreviewUrl(String url) { return act.getPreviewUrl(url); }

        // 文件预览：文本拉取（带认证头；经 window.__onFetchText 回调，超 1MB 截断）
        @JavascriptInterface public void fetchText(final String url) { act.fetchPreviewText(url); }

        // 文件预览：整文件字节拉取（Word/Excel/PDF 兼容模式；经 window.__onFetchBytes 回调，Base64，上限 24MB）
        @JavascriptInterface public void fetchBytes(final String url) { act.fetchPreviewBytes(url); }
    }
}
