package com.bstg.httpslab;

import android.app.Activity;
import android.os.Bundle;
import android.text.InputType;
import android.widget.*;
import java.net.*;
import javax.net.ssl.HttpsURLConnection;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.*;
import org.json.JSONObject;

/** Minimal native UI reference target. It really issues HTTPS; no fake responses,
 * WebView placeholder, permissive TrustManager or hostname-verifier override. */
public class MainActivity extends Activity {
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private EditText username, password;
    private TextView status;
    private Button login, profile, logout;
    private String token;
    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        LinearLayout layout = new LinearLayout(this); layout.setOrientation(LinearLayout.VERTICAL); layout.setPadding(24,24,24,24);
        username = new EditText(this); username.setId(R.id.username); username.setHint("Username"); username.setSingleLine(true); layout.addView(username);
        password = new EditText(this); password.setId(R.id.password); password.setHint("Password"); password.setSingleLine(true); password.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD); layout.addView(password);
        login = button(layout, R.id.login, "Login"); profile = button(layout, R.id.profile, "Load profile"); logout = button(layout, R.id.logout, "Logout");
        status = new TextView(this); status.setId(R.id.status); status.setText("Ready"); layout.addView(status); setContentView(layout);
        login.setOnClickListener(v -> {
            try { JSONObject body = new JSONObject(); body.put("username", username.getText().toString()); body.put("password", password.getText().toString()); request("POST", "/login", body.toString()); }
            catch (Exception ex) { status.setText("Input error"); }
        });
        profile.setOnClickListener(v -> request("GET", "/profile", null));
        logout.setOnClickListener(v -> request("POST", "/logout", "{}"));
    }
    private Button button(LinearLayout layout, int id, String text) { Button b = new Button(this); b.setId(id); b.setText(text); layout.addView(b); return b; }
    private void busy(boolean value) { login.setEnabled(!value); profile.setEnabled(!value); logout.setEnabled(!value); }
    private void request(String method, String endpoint, String body) {
        busy(true); status.setText("Loading"); final String activeToken = token;
        worker.submit(() -> {
            HttpsURLConnection conn = null;
            try {
                URL url = new URL(LabConfig.BASE_URL + endpoint);
                if (!"https".equals(url.getProtocol())) throw new IOException("HTTPS required");
                // Explicit proxy makes the demo independent of JVM ProxySelector
                // variations. Real target Apps must likewise honor their lab proxy.
                Proxy proxy = new Proxy(Proxy.Type.HTTP, new InetSocketAddress(LabConfig.PROXY_HOST, LabConfig.PROXY_PORT));
                conn = (HttpsURLConnection)url.openConnection(proxy);
                conn.setRequestMethod(method); conn.setConnectTimeout(10000); conn.setReadTimeout(10000); conn.setInstanceFollowRedirects(false);
                conn.setRequestProperty("Accept", "application/json");
                if (activeToken != null) conn.setRequestProperty("Authorization", "Bearer " + activeToken);
                if (body != null) { conn.setDoOutput(true); conn.setRequestProperty("Content-Type", "application/json"); try(OutputStream out = conn.getOutputStream()) { out.write(body.getBytes(StandardCharsets.UTF_8)); } }
                int code = conn.getResponseCode(); InputStream stream = code >= 400 ? conn.getErrorStream() : conn.getInputStream();
                ByteArrayOutputStream bytes = new ByteArrayOutputStream(); if(stream != null) try(InputStream in = stream) { byte[] buf = new byte[4096]; int n; while((n=in.read(buf))!=-1) { bytes.write(buf,0,n); if(bytes.size()>65536) throw new IOException("response too large"); } }
                JSONObject json = new JSONObject(bytes.toString("UTF-8"));
                final String newToken = endpoint.equals("/login") && code == 200 ? json.getString("token") : null;
                final String display = endpoint.equals("/login") ? (code==200 ? "Signed in" : "Login rejected") : endpoint.equals("/logout") ? (code==200 ? "Signed out" : "Unauthorized") : (code==200 ? "Profile: " + json.getJSONObject("user").getString("id") : "Unauthorized");
                runOnUiThread(() -> { if(endpoint.equals("/login")) token = newToken; if(endpoint.equals("/logout") && code==200) token=null; status.setText(display); busy(false); });
            } catch (Exception ex) { runOnUiThread(() -> { status.setText("TLS or network error"); busy(false); }); }
            finally { if (conn!=null) conn.disconnect(); }
        });
    }
    @Override protected void onDestroy() { worker.shutdownNow(); super.onDestroy(); }
}
