package com.bstg.acceptance;

import android.app.Activity;
import android.os.Bundle;
import android.widget.*;
import java.net.*;
import java.io.*;

/** Controlled acceptance target. Only talks to the base URL compiled by build.py. */
public class MainActivity extends Activity {
  private TextView result;
  private int sequence = 0;
  @Override public void onCreate(Bundle state) {
    super.onCreate(state);
    LinearLayout layout = new LinearLayout(this); layout.setOrientation(LinearLayout.VERTICAL); layout.setPadding(30,50,30,30);
    TextView title = new TextView(this); title.setText("BSTG Android Acceptance"); title.setTextSize(24); layout.addView(title);
    Button load = new Button(this); load.setText("View document"); load.setContentDescription("view-document"); layout.addView(load);
    Button next = new Button(this); next.setText("Refresh document"); next.setContentDescription("refresh-document"); layout.addView(next);
    result = new TextView(this); result.setText("Ready for authorized test"); result.setContentDescription("document-result"); layout.addView(result);
    load.setOnClickListener(v -> request()); next.setOnClickListener(v -> request()); setContentView(layout);
  }
  private void request() {
    final int current = ++sequence; result.setText("Loading document " + current);
    new Thread(() -> {
      String message;
      try {
        HttpURLConnection c = (HttpURLConnection)new URL(BuildConfig.BASE_URL + "/api/documents?object_id=101").openConnection();
        c.setRequestProperty("Authorization", "Bearer acceptance-owner-a"); c.setConnectTimeout(10000); c.setReadTimeout(10000);
        int status = c.getResponseCode(); InputStream stream = status < 400 ? c.getInputStream() : c.getErrorStream();
        ByteArrayOutputStream out = new ByteArrayOutputStream(); byte[] buf = new byte[4096]; int n;
        while ((n=stream.read(buf))!=-1) out.write(buf,0,n); stream.close(); c.disconnect();
        message = "Document " + current + ": HTTP " + status + "\n" + out.toString("UTF-8");
      } catch(Exception e) { message = "Request failed: " + e.getClass().getSimpleName() + ": " + e.getMessage(); }
      final String value = message; runOnUiThread(() -> result.setText(value));
    }).start();
  }
}
