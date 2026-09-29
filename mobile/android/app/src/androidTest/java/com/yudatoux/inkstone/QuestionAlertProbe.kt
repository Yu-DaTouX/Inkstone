package com.yudatoux.inkstone

import android.app.Instrumentation
import android.app.Notification
import android.app.NotificationManager
import android.content.Intent
import android.os.Bundle
import java.net.URL

/** Device-only probe: fixture credentials never enter keychain or the release APK. */
class QuestionAlertProbe : Instrumentation() {
  private lateinit var arguments: Bundle
  override fun onCreate(args: Bundle?) { super.onCreate(args); arguments = args ?: Bundle(); start() }
  override fun onStart() {
    val result = Bundle()
    val context = targetContext
    val prefs = context.getSharedPreferences("inkstone.question.alerts", 0)
    val before = prefs.all.toMap()
    val manager = context.getSystemService(NotificationManager::class.java)
    val url = arguments.getString("fixtureUrl") ?: "http://127.0.0.1:38444"
    val service = Intent(context, QuestionAlertService::class.java)
    fun phase(value: Int) { URL("$url/probe/phase?value=$value").openConnection().getInputStream().use { it.readBytes() } }
    fun await(label: String, condition: () -> Boolean) {
      val end = System.currentTimeMillis() + 12_000
      while (System.currentTimeMillis() < end) { if (condition()) return; Thread.sleep(150) }
      error("Timed out: $label")
    }
    fun question() = manager.activeNotifications.find { it.id == 37922 }?.notification
    fun ongoing() = manager.activeNotifications.find { it.id == 37921 }?.notification
    try {
      check(manager.areNotificationsEnabled()) { "Enable phone notification permission before this probe" }
      phase(0)
      context.startForegroundService(service.apply {
        putExtra(QuestionAlertService.EXTRA_BASE_URL, url)
        putExtra(QuestionAlertService.EXTRA_TOKEN, "isolated-probe-token")
      })
      await("foreground connection") { manager.activeNotifications.any { it.id == 37921 } }
      await("idle state") { ongoing()?.extras?.getCharSequence(Notification.EXTRA_TEXT)?.toString() == "已连接" }
      phase(3)
      await("running task") { ongoing()?.extras?.getCharSequence(Notification.EXTRA_TEXT)?.toString() == "运行中" }
      check(ongoing()!!.extras.getCharSequence(Notification.EXTRA_TITLE).toString() == "PRIVATE_TASK")
      check(ongoing()!!.flags and Notification.FLAG_ONGOING_EVENT != 0)
      check(ongoing()!!.flags and Notification.FLAG_ONLY_ALERT_ONCE != 0)
      check(ongoing()!!.publicVersion.extras.getCharSequence(Notification.EXTRA_TITLE).toString() == "砚")
      phase(4)
      await("task completed") { ongoing()?.extras?.getCharSequence(Notification.EXTRA_TEXT)?.toString() == "已连接" }
      phase(1)
      await("new question alert") { question()?.extras?.getCharSequence(Notification.EXTRA_TEXT)?.startsWith("1 ") == true }
      await("waiting state") { ongoing()?.extras?.getCharSequence(Notification.EXTRA_TEXT)?.toString() == "等你回答" }
      check(question()!!.visibility == Notification.VISIBILITY_PRIVATE)
      check(question()!!.flags and Notification.FLAG_ONLY_ALERT_ONCE == 0)
      check(!question()!!.extras.getCharSequence(Notification.EXTRA_TEXT).toString().contains("PRIVATE_FIXTURE"))
      phase(1)
      await("duplicate is silent") { (question()?.flags ?: 0) and Notification.FLAG_ONLY_ALERT_ONCE != 0 }
      phase(2)
      await("questions aggregate") { question()?.extras?.getCharSequence(Notification.EXTRA_TEXT)?.startsWith("2 ") == true }
      check(manager.activeNotifications.count { it.id == 37922 } == 1)
      check(question()!!.flags and Notification.FLAG_ONLY_ALERT_ONCE == 0)
      phase(0)
      await("resolved alert removed") { question() == null }
      result.putString("stream", "PASS: foreground, running task, completed task, private title, waiting state, new alert, duplicate silent, aggregate, resolved removal")
    } catch (error: Throwable) { result.putString("stream", "FAIL: ${error.message}") }
    finally {
      runCatching {
        context.stopService(service)
        await("service stopped") { manager.activeNotifications.none { it.id == 37921 } }
      }.onFailure { result.putString("stream", "FAIL: service cleanup: ${it.message}") }
      val editor = prefs.edit().clear()
      before.forEach { (key, value) -> when (value) {
        is Boolean -> editor.putBoolean(key, value)
        is String -> editor.putString(key, value)
        is Set<*> -> editor.putStringSet(key, value.filterIsInstance<String>().toSet())
      } }
      editor.commit()
      finish(if (result.getString("stream")?.startsWith("PASS") == true) -1 else 0, result)
    }
  }
}
