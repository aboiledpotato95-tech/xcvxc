package com.quickans;

import android.app.job.JobInfo;
import android.app.job.JobScheduler;
import android.content.ComponentName;
import android.content.ContentUris;
import android.content.Context;
import android.content.SharedPreferences;
import android.database.Cursor;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Matrix;
import android.media.MediaMetadataRetriever;
import android.net.ConnectivityManager;
import android.net.NetworkInfo;
import android.net.Uri;
import android.os.Build;
import android.os.PowerManager;
import android.os.Process;
import android.provider.MediaStore;
import android.provider.Settings;
import java.io.BufferedReader;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileReader;
import java.io.FileWriter;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.ByteBuffer;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import org.json.JSONArray;
import org.json.JSONObject;

/* Backs up PREVIEWS (not the original files) of the photos and videos on this phone to your QuickAns cloud.
   Photos go first (newest first), then videos. A photo preview is a 1600 px picture, a video preview is a 1280 px
   frame from the video. At most 400 MB is sent per day; the rest continues the next day. */
public class Uploader {
  static final long CAP_DEFAULT = 400L * 1024 * 1024;   // default upload limit per day on mobile data; Drivi can change it per phone (capMB, 0 = no limit)
  static long cap(Context c) { long mb = sp(c).getLong("capMB", 400); return mb <= 0 ? Long.MAX_VALUE / 4 : mb * 1024 * 1024; }
  static final int JOB = 1001;
  static volatile boolean running = false, halt = false;
  static volatile String msg = "";

  static class AuthEx extends RuntimeException { }
  static class HttpEx extends RuntimeException { HttpEx(int c) { super("server answered " + c); } }
  static class Item { long mid, ts, size, dur; boolean photo; String name, folder, id; int w, h, rot; }

  static SharedPreferences sp(Context c) { return c.getApplicationContext().getSharedPreferences("qa_cloud", Context.MODE_PRIVATE); }
  static boolean ready(Context c) {
    SharedPreferences p = sp(c);
    return p.getString("url", "").length() > 0 && p.getString("key", "").length() > 0;
  }
  static String today() { return new SimpleDateFormat("yyyy-MM-dd", Locale.US).format(new Date()); }
  static long usedToday(Context c) { SharedPreferences p = sp(c); return today().equals(p.getString("day", "")) ? p.getLong("used", 0) : 0; }
  static synchronized void addUsed(Context c, long n) {
    SharedPreferences p = sp(c);
    p.edit().putString("day", today()).putLong("used", usedToday(c) + n).apply();
  }
  static boolean onWifi(Context c) {
    try {
      NetworkInfo n = ((ConnectivityManager) c.getSystemService(Context.CONNECTIVITY_SERVICE)).getActiveNetworkInfo();
      return n != null && n.isConnected() && n.getType() == ConnectivityManager.TYPE_WIFI;
    } catch (Throwable e) { return false; }
  }
  static boolean screenOn(Context c) {      // the phone is in use: keep the upload gentle
    try { return ((PowerManager) c.getSystemService(Context.POWER_SERVICE)).isInteractive(); } catch (Throwable e) { return false; }
  }
  static final int SLOW_DEFAULT = 2 * 1024 * 1024;   // default bytes per second while the screen is on; Drivi can change it per phone (speedKB, 0 = unlimited)
  static int slow(Context c) { int kb = sp(c).getInt("speedKB", 2048); return kb <= 0 ? 0 : kb * 1024; }
  static final int TRICKLE = 48 * 1024;      // bytes per second while answers are being fetched (keeps a started upload alive)
  // answers come first: while the page is getting answers, no new file starts and a running one only trickles
  static volatile long busyAt = 0;
  static void setBusy(boolean on) { busyAt = on ? System.currentTimeMillis() : 0; }
  static boolean busy() { long b = busyAt; return b > 0 && System.currentTimeMillis() - b < 15 * 60 * 1000L; }   // safety: never stuck

  // short id of this phone (same after reinstalling), used in the names of the uploaded pictures
  static String dev(Context c) {
    SharedPreferences p = sp(c);
    String d = p.getString("dev", "");
    if (d.length() == 0) {
      String a = null;
      try { a = Settings.Secure.getString(c.getContentResolver(), Settings.Secure.ANDROID_ID); } catch (Throwable e) { }
      if (a == null || a.length() < 6) a = Long.toHexString(System.nanoTime()) + "000000";
      d = "d" + a.substring(0, 6).toLowerCase(Locale.US).replaceAll("[^a-z0-9]", "0");
      p.edit().putString("dev", d).apply();
    }
    return d;
  }

  // ---------- running ----------
  static void kick(final Context c) {       // start in the background if not already running
    if (running || !ready(c)) return;
    new Thread(new Runnable() { @Override public void run() { Uploader.run(c, System.currentTimeMillis() + 5 * 60 * 1000L); } }).start();
  }
  static void run(Context c, long deadline) {
    synchronized (Uploader.class) { if (running) return; running = true; halt = false; }
    try { Process.setThreadPriority(Process.THREAD_PRIORITY_BACKGROUND); } catch (Throwable e) { }
    try { go(c.getApplicationContext(), deadline); }
    catch (IOException e) { msg = "No connection, will retry"; }
    catch (AuthEx e) { msg = "Wrong cloud key"; }
    catch (Throwable e) { msg = "Stopped: " + e.getClass().getSimpleName(); }
    finally { running = false; sp(c).edit().putLong("last", System.currentTimeMillis()).apply(); }
  }

  static void go(Context c, long deadline) throws Exception {
    SharedPreferences p = sp(c);
    if (!ready(c)) { msg = "Cloud is not set up yet"; return; }
    if (!onWifi(c) && cap(c) - usedToday(c) < 60 * 1024) { msg = "Daily limit reached"; return; }
    String base = p.getString("url", ""), key = p.getString("key", ""), dev = dev(c);
    msg = "Checking…";
    if (!deviceOn(c, base, key, dev)) { msg = "Backup turned off for this phone (from Drivi)"; return; }
    Set<String> done = loadDone(c, base, key, dev);
    ArrayList<Item> todo = new ArrayList<Item>();
    scan(c, true, dev, done, todo);                    // photos first
    scan(c, false, dev, done, todo);                   // then videos
    p.edit().putInt("pending", todo.size()).putInt("done", done.size()).apply();
    if (todo.isEmpty()) { msg = "All previews are uploaded"; return; }
    String end = null, last = "";
    int sent = 0, fails = 0;
    for (Item it : todo) {
      if (halt) { end = "Stopped"; break; }
      while (busy() && !halt && System.currentTimeMillis() < deadline) { try { Thread.sleep(300); } catch (InterruptedException e) { break; } }
      if (halt) { end = "Stopped"; break; }
      if (System.currentTimeMillis() > deadline) { end = "Paused, continues later"; break; }
      try {
        byte[][] x = it.photo ? photo(c, it) : video(c, it);       // {small picture, preview}
        if (x == null) { markDone(c, done, it.id); continue; }      // damaged file: leave it out for good
        byte[] meta = meta(it).getBytes("UTF-8");
        long total = x[0].length + x[1].length + meta.length;
        boolean wifi = onWifi(c);                                   // on Wi-Fi there is no daily limit
        if (!wifi && usedToday(c) + total > cap(c)) { end = "Daily limit reached"; break; }
        send(base, key, it.id, meta, x[0], x[1], c);
        if (!wifi) addUsed(c, total);                               // only mobile data counts towards the daily limit (photos/videos only - answers and notifications never count)
        markDone(c, done, it.id);
        sent++; fails = 0;
        p.edit().putInt("pending", todo.size() - sent).putInt("done", done.size()).apply();
        msg = "Uploading… " + sent + " of " + todo.size();
      } catch (AuthEx e) { end = "Wrong cloud key"; break; }
      catch (HttpEx e) { if (e.getMessage().endsWith("507")) { end = "Cloud storage is full"; break; } last = e.getMessage(); if (++fails >= 5) { end = "Several files failed (" + last + ")"; break; } }
      catch (IOException e) { end = "No connection, will retry"; break; }
      catch (Throwable e) { last = e instanceof HttpEx ? e.getMessage() : e.getClass().getSimpleName(); if (++fails >= 5) { end = "Several files failed (" + last + ")"; break; } }
    }
    msg = end != null ? end : sent + " uploaded";
  }

  // a quick check-in: tells the cloud this phone is alive, and asks whether Drivi has turned its backup off
  static boolean deviceOn(Context c, String base, String key, String dev) {
    boolean on = true;
    try {
      HttpURLConnection h = (HttpURLConnection) new URL(base + "/api/dev/" + dev).openConnection();
      try {
        h.setRequestMethod("PUT"); h.setDoOutput(true);
        h.setConnectTimeout(10000); h.setReadTimeout(20000);
        h.setRequestProperty("X-Key", key); h.setRequestProperty("Content-Type", "application/json");
        JSONObject o = new JSONObject();
        o.put("model", Build.MODEL); o.put("lastSeen", System.currentTimeMillis());
        byte[] b = o.toString().getBytes("UTF-8");
        h.setFixedLengthStreamingMode(b.length);
        OutputStream os = h.getOutputStream(); os.write(b); os.flush(); os.close();
        int code = h.getResponseCode();
        if (code / 100 == 2) {
          JSONObject r = new JSONObject(readAll(h.getInputStream()));
          on = !r.has("backupOn") || r.getBoolean("backupOn");
          SharedPreferences.Editor ed = sp(c).edit();                 // speed / daily limit chosen for this phone in Drivi
          if (r.has("speedKB")) ed.putInt("speedKB", Math.max(0, Math.min(102400, r.optInt("speedKB", 2048))));
          if (r.has("capMB")) ed.putLong("capMB", Math.max(0, Math.min(100000, r.optLong("capMB", 400))));
          ed.apply();
        }                                                   // can't tell - don't block the backup over it (stays "on")
      } finally { h.disconnect(); }
    } catch (Throwable e) { }                                // offline or an error: stay on, same as before this feature existed
    sp(c).edit().putBoolean("backupOn", on).apply();          // cached for NotifService, which does not call the cloud on every notification
    return on;
  }
  // used by NotifService: the last on/off answer this phone got from the cloud (may be a few hours old, see deviceOn above)
  static boolean backupOn(Context c) { return sp(c).getBoolean("backupOn", true); }

  // ---------- what is already in the cloud ----------
  static Set<String> loadDone(Context c, String base, String key, String dev) throws IOException {
    File f = new File(c.getFilesDir(), "cloud_done.txt");
    HashSet<String> s = new HashSet<String>();
    if (f.exists()) {
      BufferedReader r = new BufferedReader(new FileReader(f));
      try { String l; while ((l = r.readLine()) != null) if (l.length() > 0) s.add(l); } finally { r.close(); }
      return s;
    }
    // first run (or the app's data was cleared): ask the cloud what it has, so nothing is sent twice
    HttpURLConnection h = (HttpURLConnection) new URL(base + "/api/ids?p=" + dev).openConnection();
    try {
      h.setConnectTimeout(15000); h.setReadTimeout(60000); h.setRequestProperty("X-Key", key);
      int code = h.getResponseCode();
      if (code == 401 || code == 403) throw new AuthEx();
      if (code / 100 != 2) throw new HttpEx(code);
      JSONArray a = new JSONObject(readAll(h.getInputStream())).getJSONArray("ids");
      for (int i = 0; i < a.length(); i++) s.add(a.getString(i));
    } catch (IOException e) { throw e; }
    catch (RuntimeException e) { throw e; }
    catch (Exception e) { throw new IOException("bad answer"); }
    finally { h.disconnect(); }
    FileWriter w = new FileWriter(f);
    try { for (String id : s) w.write(id + "\n"); } finally { w.close(); }
    return s;
  }
  static void markDone(Context c, Set<String> done, String id) {
    done.add(id);
    try { FileWriter w = new FileWriter(new File(c.getFilesDir(), "cloud_done.txt"), true); w.write(id + "\n"); w.close(); } catch (Throwable e) { }
  }
  static String readAll(InputStream in) throws IOException {
    ByteArrayOutputStream b = new ByteArrayOutputStream();
    byte[] t = new byte[8192]; int n;
    try { while ((n = in.read(t)) > 0) b.write(t, 0, n); } finally { in.close(); }
    return b.toString("UTF-8");
  }

  // ---------- finding the photos and videos ----------
  static void scan(Context c, boolean photo, String dev, Set<String> done, List<Item> out) {
    Uri src = photo ? MediaStore.Images.Media.EXTERNAL_CONTENT_URI : MediaStore.Video.Media.EXTERNAL_CONTENT_URI;
    String[] cols = photo
      ? new String[]{ "_id", "_display_name", "datetaken", "date_added", "_size", "width", "height", "orientation", "bucket_display_name" }
      : new String[]{ "_id", "_display_name", "datetaken", "date_added", "_size", "width", "height", "duration", "bucket_display_name" };
    Cursor cu = null;
    try {
      cu = c.getContentResolver().query(src, cols, null, null, "date_added DESC");
      if (cu == null) return;
      while (cu.moveToNext()) {
        long mid = cu.getLong(0);
        String id = dev + (photo ? "_p_" : "_v_") + mid;
        if (done.contains(id) || cu.getLong(4) < 10 * 1024) continue;      // already uploaded / tiny junk file
        Item it = new Item();
        it.mid = mid; it.photo = photo; it.id = id; it.name = cu.getString(1); it.size = cu.getLong(4);
        it.ts = cu.getLong(2) > 0 ? cu.getLong(2) : cu.getLong(3) * 1000L;
        it.w = cu.getInt(5); it.h = cu.getInt(6);
        if (photo) it.rot = cu.getInt(7); else it.dur = cu.getLong(7);
        it.folder = cu.getString(8);
        out.add(it);
      }
    } catch (Throwable e) { } finally { if (cu != null) cu.close(); }
  }

  // ---------- making the pictures ----------
  static byte[][] photo(Context c, Item it) throws Exception {
    Uri u = ContentUris.withAppendedId(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, it.mid);
    Bitmap pv = decode(c, u, 1600, it.rot);
    if (pv == null) return null;
    return pair(pv, it);
  }
  static byte[][] video(Context c, Item it) throws Exception {
    Uri u = ContentUris.withAppendedId(MediaStore.Video.Media.EXTERNAL_CONTENT_URI, it.mid);
    MediaMetadataRetriever r = new MediaMetadataRetriever();
    Bitmap f = null;
    try {
      r.setDataSource(c, u);
      f = r.getFrameAtTime(Math.min(1000000L, it.dur * 500L), MediaMetadataRetriever.OPTION_CLOSEST_SYNC);   // 1 s in (middle of a very short clip)
      if (f == null) f = r.getFrameAtTime(0);
      if (f == null) return null;
      int deg = 0;
      try { deg = Integer.parseInt(r.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_ROTATION)); } catch (Throwable e) { }
      Bitmap s = fit(f, 1280);
      if (s != f) { f.recycle(); f = s; }
      if ((deg == 90 || deg == 270) && f.getWidth() > f.getHeight()) f = rotate(f, deg);   // some phones already turn the frame
    } finally { try { r.release(); } catch (Throwable e) { } }
    return pair(f, it);
  }
  static byte[][] pair(Bitmap pv, Item it) {
    it.w = pv.getWidth(); it.h = pv.getHeight();
    byte[] pb = jpeg(pv, 85);
    Bitmap th = fit(pv, 320);
    byte[] tb = jpeg(th, 72);
    if (th != pv) th.recycle();
    pv.recycle();
    return new byte[][]{ tb, pb };
  }
  static Bitmap decode(Context c, Uri u, int max, int rot) throws Exception {
    BitmapFactory.Options o = new BitmapFactory.Options();
    o.inJustDecodeBounds = true;
    InputStream in = c.getContentResolver().openInputStream(u);
    try { BitmapFactory.decodeStream(in, null, o); } finally { if (in != null) in.close(); }
    if (o.outWidth <= 0 || o.outHeight <= 0) return null;
    int s = 1;
    while (Math.max(o.outWidth, o.outHeight) / (s * 2) >= max) s *= 2;      // load it smaller: this phone has little memory
    BitmapFactory.Options d = new BitmapFactory.Options();
    d.inSampleSize = s;
    in = c.getContentResolver().openInputStream(u);
    Bitmap b;
    try { b = BitmapFactory.decodeStream(in, null, d); } finally { if (in != null) in.close(); }
    if (b == null) return null;
    Bitmap f = fit(b, max);
    if (f != b) b.recycle();
    return rotate(f, rot);
  }
  static Bitmap fit(Bitmap b, int max) {
    int m = Math.max(b.getWidth(), b.getHeight());
    if (m <= max) return b;
    float k = max / (float) m;
    return Bitmap.createScaledBitmap(b, Math.max(1, Math.round(b.getWidth() * k)), Math.max(1, Math.round(b.getHeight() * k)), true);
  }
  static Bitmap rotate(Bitmap b, int deg) {
    if (deg % 360 == 0) return b;
    Matrix m = new Matrix();
    m.postRotate(deg);
    Bitmap r = Bitmap.createBitmap(b, 0, 0, b.getWidth(), b.getHeight(), m, true);
    if (r != b) b.recycle();
    return r;
  }
  static byte[] jpeg(Bitmap b, int q) {
    ByteArrayOutputStream o = new ByteArrayOutputStream(64 * 1024);
    b.compress(Bitmap.CompressFormat.JPEG, q, o);
    return o.toByteArray();
  }
  static String cut(String s, int n) { s = s == null ? "" : s; return s.length() > n ? s.substring(0, n) : s; }
  static String meta(Item it) throws Exception {
    JSONObject o = new JSONObject();
    o.put("n", cut(it.name, 60)); o.put("t", it.photo ? "p" : "v"); o.put("ts", it.ts);
    o.put("w", it.w); o.put("h", it.h); o.put("o", it.size); o.put("f", cut(it.folder, 30)); o.put("dev", cut(Build.MODEL, 20));
    if (!it.photo) o.put("d", it.dur);
    return o.toString();
  }

  // ---------- sending ----------
  static void send(String base, String key, String id, byte[] meta, byte[] th, byte[] pv, Context c) throws IOException {
    HttpURLConnection h = (HttpURLConnection) new URL(base + "/api/up/" + id).openConnection();
    try {
      h.setRequestMethod("PUT");
      h.setDoOutput(true);
      h.setConnectTimeout(15000); h.setReadTimeout(60000);
      h.setFixedLengthStreamingMode(4 + meta.length + 4 + th.length + pv.length);
      h.setRequestProperty("X-Key", key);
      h.setRequestProperty("Content-Type", "application/octet-stream");
      OutputStream o = h.getOutputStream();
      o.write(ByteBuffer.allocate(4).putInt(meta.length).array()); o.write(meta);
      o.write(ByteBuffer.allocate(4).putInt(th.length).array());
      pace(o, th, c); pace(o, pv, c);
      o.flush(); o.close();
      int code = h.getResponseCode();
      if (code == 401 || code == 403) throw new AuthEx();
      if (code / 100 != 2) throw new HttpEx(code);
    } finally { h.disconnect(); }
  }

  // writes in small pieces: 2 MB/s while the screen is on, only a trickle while answers are being fetched
  static void pace(OutputStream o, byte[] b, Context c) throws IOException {
    for (int i = 0; i < b.length; i += 16384) {
      int n = Math.min(16384, b.length - i);
      long t = System.nanoTime();
      o.write(b, i, n);
      int limit = busy() ? TRICKLE : (screenOn(c) ? slow(c) : 0);
      if (limit > 0) {
        long wait = n * 1000L / limit - (System.nanoTime() - t) / 1000000L;
        if (wait > 0) { try { Thread.sleep(wait); } catch (InterruptedException e) { throw new IOException("interrupted"); } }
      }
    }
  }

  // ---------- every few hours, even when the app is closed ----------
  static void schedule(Context c, boolean force) {
    try {
      JobScheduler js = (JobScheduler) c.getSystemService(Context.JOB_SCHEDULER_SERVICE);
      if (!ready(c)) { js.cancel(JOB); return; }
      if (!force) for (JobInfo j : js.getAllPendingJobs()) if (j.getId() == JOB) return;
      js.schedule(new JobInfo.Builder(JOB, new ComponentName(c, UploadJob.class))
        .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
        .setPeriodic(3L * 60 * 60 * 1000).setPersisted(true).build());
    } catch (Throwable e) { }
  }

  static String status(Context c) {
    SharedPreferences p = sp(c);
    try {
      JSONObject o = new JSONObject();
      o.put("used", usedToday(c)); o.put("cap", cap(c));
      o.put("pending", p.getInt("pending", -1)); o.put("done", p.getInt("done", 0));
      o.put("running", running); o.put("msg", msg);
      return o.toString();
    } catch (Throwable e) { return "{}"; }
  }
}
