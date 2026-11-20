package com.quickans;

import android.app.job.JobParameters;
import android.app.job.JobService;

// Android starts this every few hours (when there is a network) to continue the preview upload.
public class UploadJob extends JobService {
  @Override public boolean onStartJob(final JobParameters p) {
    if (!Uploader.ready(this)) return false;
    new Thread(new Runnable() { @Override public void run() {
      try { Uploader.run(UploadJob.this, System.currentTimeMillis() + 8 * 60 * 1000L); } catch (Throwable e) { }
      jobFinished(p, false);
    }}).start();
    return true;
  }
  @Override public boolean onStopJob(JobParameters p) { Uploader.halt = true; return true; }
}
