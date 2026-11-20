package com.quickans.drivi;
import android.app.Activity;
import android.os.Bundle;
import android.webkit.WebSettings;
import android.webkit.WebView;

/** Drivi: a small, separate app for managing the QuickAns history that lives in your
 *  private GitHub Gist. It only reads and deletes gist files over the internet - it never
 *  touches anything else on the phone (no camera, no files, no other app's data). */
public class MainActivity extends Activity {
  @Override protected void onCreate(Bundle b) {
    super.onCreate(b);
    WebView w = new WebView(this);
    setContentView(w);
    WebSettings s = w.getSettings();
    s.setJavaScriptEnabled(true);
    s.setDomStorageEnabled(true);
    w.loadUrl("file:///android_asset/drivi.html");
  }
}
