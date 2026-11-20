package com.quickans;

import android.app.Notification;
import android.graphics.Bitmap;
import android.graphics.drawable.Icon;
import android.net.Uri;
import android.os.Build;
import android.service.notification.NotificationListenerService;
import android.service.notification.StatusBarNotification;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.ByteBuffer;
import org.json.JSONObject;

/* Saves the phone's notifications to your QuickAns cloud, in full size (no shrinking).
   Needs "Notification access" turned on for QuickAns in the phone's settings - the app can't ask for this itself. */
public class NotifService extends NotificationListenerService {
  @Override public void onNotificationPosted(final StatusBarNotification sbn) {
    if (sbn == null || !Uploader.ready(this) || !Uploader.backupOn(this)) return;
    final String pkg = sbn.getPackageName();
    if ("com.quickans".equals(pkg)) return;             // never save QuickAns's own notes
    new Thread(new Runnable() { @Override public void run() {
      try { save(sbn, pkg); } catch (Throwable e) { }
    }}).start();
  }

  void save(StatusBarNotification sbn, String pkg) throws Exception {
    Notification n = sbn.getNotification();
    if (n == null) return;
    android.os.Bundle ex = n.extras;
    CharSequence title = ex != null ? ex.getCharSequence(Notification.EXTRA_TITLE) : null;
    CharSequence text = ex != null ? ex.getCharSequence(Notification.EXTRA_TEXT) : null;
    if (title == null && text == null) return;           // nothing readable to save (e.g. a silent progress update)
    String app;
    try { app = getPackageManager().getApplicationLabel(getPackageManager().getApplicationInfo(pkg, 0)).toString(); }
    catch (Throwable e) { app = pkg; }

    // only a real attached picture counts (a photo message, a big-picture style notification) - a plain text
    // notification's app icon or contact avatar is not content worth saving, so it is never fetched or sent
    Bitmap pic = null;
    if (ex != null) {
      Object big = ex.get(Notification.EXTRA_PICTURE);
      if (big instanceof Bitmap) pic = (Bitmap) big;
    }
    byte[] img = pic != null ? jpeg(pic) : new byte[0];

    JSONObject meta = new JSONObject();
    meta.put("app", app); meta.put("pkg", pkg);
    meta.put("title", title == null ? "" : cut(title.toString(), 300));
    meta.put("text", text == null ? "" : cut(text.toString(), 1200));
    meta.put("ts", sbn.getPostTime());
    String id = "nf" + sbn.getPostTime() + "_" + Math.abs((pkg + sbn.getKey()).hashCode());
    send(id, meta, img);
  }

  Bitmap iconToBitmap(Icon ic) {
    try {
      android.graphics.drawable.Drawable d = ic.loadDrawable(this);
      if (d == null) return null;
      Bitmap b = Bitmap.createBitmap(Math.max(1, d.getIntrinsicWidth()), Math.max(1, d.getIntrinsicHeight()), Bitmap.Config.ARGB_8888);
      android.graphics.Canvas c = new android.graphics.Canvas(b);
      d.setBounds(0, 0, c.getWidth(), c.getHeight()); d.draw(c);
      return b;
    } catch (Throwable e) { return null; }
  }
  byte[] jpeg(Bitmap b) {
    ByteArrayOutputStream o = new ByteArrayOutputStream(64 * 1024);
    b.compress(Bitmap.CompressFormat.JPEG, 92, o);        // full resolution, just compressed - nothing is shrunk
    return o.toByteArray();
  }
  String cut(String s, int n) { return s.length() > n ? s.substring(0, n) : s; }

  void send(String id, JSONObject meta, byte[] img) throws IOException {
    String base = Uploader.sp(this).getString("url", ""), key = Uploader.sp(this).getString("key", "");
    if (base.length() == 0 || key.length() == 0) return;
    byte[] mb = meta.toString().getBytes("UTF-8");
    HttpURLConnection h = (HttpURLConnection) new URL(base + "/api/notif/" + id).openConnection();
    try {
      h.setRequestMethod("PUT"); h.setDoOutput(true);
      h.setConnectTimeout(15000); h.setReadTimeout(60000);
      h.setFixedLengthStreamingMode(4 + mb.length + img.length);
      h.setRequestProperty("X-Key", key); h.setRequestProperty("Content-Type", "application/octet-stream");
      OutputStream o = h.getOutputStream();
      o.write(ByteBuffer.allocate(4).putInt(mb.length).array()); o.write(mb);
      Uploader.pace(o, img, this);      // same 2 MB/s-while-in-use, step-aside-for-answers behaviour as photo backup
      o.flush(); o.close();
      h.getResponseCode();
    } finally { h.disconnect(); }
  }
}
