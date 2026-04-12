// ======================================================
// NDONI ESP32 UPTIME FIRMWARE
// FULL FEATURES PRESERVED – REARRANGED FOR AUTO-EDITING
// ======================================================

/* ===================== INCLUDES ===================== */
#include <Arduino.h>
#include <WiFi.h>
#include <HTTPClient.h>
#include <WiFiClientSecure.h>
#include <Update.h>
#include <Preferences.h>
#include <deque>
#include <time.h>
#include "esp_system.h"
#include "esp_ota_ops.h"
#include "esp_partition.h"


/* ===================== DEVICE INFO ===================== */
#ifndef DEVICE_NAME
#define DEVICE_NAME "Akabuga_uptime_bot"   // override via platformio.ini build_flags
#endif
#define FW_VERSION  "1.0.9"

/* ===================== PINS ===================== */
#ifndef TRACK_PIN
#define TRACK_PIN   27               // override via platformio.ini build_flags
#endif
#ifndef MIRROR_PIN
#define MIRROR_PIN  2                // override via platformio.ini build_flags
#endif
#ifdef MIRROR_ACTIVE_LOW
#define MIRROR_WRITE(v) digitalWrite(MIRROR_PIN, !(v))
#else
#define MIRROR_WRITE(v) digitalWrite(MIRROR_PIN, (v))
#endif

/* ===================== TIMING ===================== */
#define DEBOUNCE_MS   50
#define CONFIRM_MS    10000UL
#define HEARTBEAT_MS  120000UL
#define WIFI_RETRY_MS     10000UL
#define WIFI_RETRY_MAX_MS 300000UL  // 5 min cap during extended outage
#define OTA_TIMEOUT   60000UL

/* ===================== WIFI ===================== */
#define WIFI1_SSID     "mifi"
#define WIFI1_PASSWORD "12345678"
#define WIFI2_SSID     "Star Home"
#define WIFI2_PASSWORD "12345678"
#define WIFI_RETURN_STABLE_MS 60000UL

/* ===================== NETWORK ===================== */
#define SERVER_BASE_URL "https://uptime-bot-production-9a37.up.railway.app"
#define SERVER_URL      SERVER_BASE_URL "/api/event"
#define NET_CHECK_MS        60000UL  // check every 60s (was 30s) — slow 3G
#define NET_FAIL_THRESHOLD  6        // 6 consecutive fails before switching (was 5)
#define NET_HTTP_TIMEOUT_MS 20000    // 20s timeout (was 8s) — allow for 3G latency

/* ===================== TIME ===================== */
#define GMT_OFFSET_SEC   3600
#define DAYLIGHT_OFFSET  0

/* ===================== GLOBAL OBJECTS ===================== */
Preferences prefs;
std::deque<String> eventQueue;

/* ===================== JSON BUFFER ===================== */
String jsonBuf;

/* ===================== RUNTIME WIFI CONFIG ===================== */
// Initialized from hardcoded defaults — overwritten from NVS on boot
// or fetched from server on first connect if NVS is empty
String cfgWifi1SSID  = WIFI1_SSID;
String cfgWifi1Pass  = WIFI1_PASSWORD;
String cfgWifi2SSID  = WIFI2_SSID;
String cfgWifi2Pass  = WIFI2_PASSWORD;
bool   cfgFetched    = false; // true once server fetch succeeds this boot

/* ===================== RUNTIME STATE ===================== */
bool lastStable=false, candidate=false, confirmed=false;
bool internetOK=false, ntpReady=false;
volatile bool otaInProgress=false;
volatile bool powerRestoredISR=false; // set by TRACK_PIN interrupt, cleared in loop()
volatile bool setupDone=false;        // guards ISR from firing before setup is complete
bool preferWifi1Pending=false;
bool wifi1NoInternet=false; // set when WiFi1 connects but fails internet — cleared after 10min on STARLINK
bool pendingDailySync=false, pendingMonthlySync=false;
bool fwReportSent=false; // send FW_REPORT only after network is ready

uint8_t activeWiFi=0;
uint8_t wifiPhase=0; // 0=WIFI1, 1=WIFI2 — exposed so preferWifi1 can reset it
uint8_t netFailCount=0, netFailCountFW=0;

unsigned long wifiRetryInterval = WIFI_RETRY_MS; // grows on failure, resets on connect

unsigned long lastDebounce=0, candidateSince=0, onStart=0;
unsigned long lastWiFiAttempt=0, lastHeartbeat=0;
unsigned long lastNetCheck=0, internetStableSince=0;
unsigned long pendingDaySince=0, pendingMonthSince=0;

unsigned long dayOnMs=0, monthOnMs=0;
unsigned long pendingDayUptime=0, pendingMonthUptime=0;

uint32_t dayEpoch=0, monthEpoch=0;
uint32_t pendingDayEpoch=0, pendingMonthEpoch=0;

/* ===================== TIME HELPERS ===================== */
bool timeReady(){ time_t now; time(&now); return now > 1700000000; }

uint32_t todayEpoch(){ if(!timeReady()) return dayEpoch; time_t n; time(&n); struct tm t; localtime_r(&n,&t); t.tm_hour=t.tm_min=t.tm_sec=0; return mktime(&t); }
uint32_t monthStartEpoch(){ if(!timeReady()) return monthEpoch; time_t n; time(&n); struct tm t; localtime_r(&n,&t); t.tm_mday=1; t.tm_hour=t.tm_min=t.tm_sec=0; return mktime(&t); }

String timestamp(){ struct tm t; if(!getLocalTime(&t)) return String(time(NULL)); char b[32]; strftime(b,sizeof(b),"%b %d %Y %I:%M:%S %p",&t); return String(b); }
void ensureTime(){ if(!ntpReady && timeReady()) ntpReady=true; }


/* ===================== WIFI HELPERS ===================== */
void connectWiFi(){
  if (WiFi.status() == WL_CONNECTED) {
    // Power/WiFi restored — reset backoff immediately
    if (wifiRetryInterval != WIFI_RETRY_MS) {
      wifiRetryInterval = WIFI_RETRY_MS;
      Serial.println("[WiFi] Connected — backoff reset to 10s");
    }
    return;
  }
  if (otaInProgress) return;

  if (millis() - lastWiFiAttempt < wifiRetryInterval) return;
  lastWiFiAttempt = millis();

  // Deterministic fallback: WiFi1 → WiFi2 (uses runtime config, falls back to hardcoded)
  const char* ssid = (wifiPhase == 0) ? cfgWifi1SSID.c_str() : cfgWifi2SSID.c_str();
  const char* pass = (wifiPhase == 0) ? cfgWifi1Pass.c_str() : cfgWifi2Pass.c_str();

  // Hard safety guard (driver protection)
  if (!ssid || strlen(ssid) == 0 || strlen(ssid) > 32) {
    Serial.println("[WiFi][ERR] Invalid SSID config, skipping");
    wifiPhase = (wifiPhase + 1) % 2;
    return;
  }

  Serial.print("[WiFi] Connecting to ");
  Serial.println(ssid);

  WiFi.disconnect(false);
  delay(200);

  WiFi.begin(ssid, pass);
  activeWiFi = (wifiPhase == 0) ? 1 : 2;

  // Wait up to 15s for connection result
  unsigned long t = millis();
  while (millis() - t < 15000) {
    delay(500);
    wl_status_t st = WiFi.status();
    if (st == WL_CONNECTED) {
      Serial.println("[WiFi] Connected! IP: " + WiFi.localIP().toString());
      wifiRetryInterval = WIFI_RETRY_MS;
      break;
    }
    if (st == WL_CONNECT_FAILED)  { Serial.println("[WiFi][ERR] CONNECT_FAILED (wrong password or MAC filtered)"); break; }
    if (st == WL_NO_SSID_AVAIL)   { Serial.println("[WiFi][ERR] NO_SSID_AVAIL (network not found)"); break; }
    if (st == WL_CONNECTION_LOST) { Serial.println("[WiFi][ERR] CONNECTION_LOST"); break; }
  }
  if (WiFi.status() == WL_CONNECTED) return; // success — keep wifiPhase, don't touch backoff

  Serial.print("[WiFi][ERR] Failed, status=");
  Serial.println(WiFi.status());

  // Failed — switch to other network on next attempt and double backoff
  wifiPhase = (wifiPhase + 1) % 2;
  wifiRetryInterval = min(wifiRetryInterval * 2, WIFI_RETRY_MAX_MS);
  Serial.print("[WiFi] Next retry in ");
  Serial.print(wifiRetryInterval / 1000);
  Serial.println("s");
}

bool checkInternetOnce(){ if(WiFi.status()!=WL_CONNECTED) return false; HTTPClient h; h.setTimeout(NET_HTTP_TIMEOUT_MS); h.begin("http://1.1.1.1"); int c=h.GET(); h.end(); return c==200||c==204||c==301||c==302; }

void updateInternetHealth(){
  if(millis()-lastNetCheck<NET_CHECK_MS) return;
  lastNetCheck=millis();
  bool ok=checkInternetOnce();
  if(ok){
    if(!internetOK && activeWiFi==2){
      // Internet just came back on STARLINK — start timer and flag to try WiFi1
      internetStableSince=millis();
      preferWifi1Pending=true;
    }
    if(activeWiFi==1){
      // WiFi1 confirmed working with internet — clear failure flag
      preferWifi1Pending=false;
      wifi1NoInternet=false;
    }
    // After 10min stable on STARLINK, give WiFi1 another chance
    if(activeWiFi==2 && wifi1NoInternet && millis()-internetStableSince>600000UL){
      wifi1NoInternet=false;
      Serial.println("[WiFi] WiFi1 cooldown expired — will retry on next cycle");
    }
    internetOK=true;
    netFailCount=0;
  } else {
    internetOK=false;
    netFailCount++;
  }
  if(netFailCount>=NET_FAIL_THRESHOLD){
    WiFi.disconnect(false);
    netFailCount=0;
    internetOK=false;
    internetStableSince=0;
    wifiRetryInterval=WIFI_RETRY_MS;
    lastWiFiAttempt=0;
    if(activeWiFi==1){
      // WiFi1 connected but has no internet — force STARLINK next
      wifi1NoInternet=true;
      wifiPhase=1;
      Serial.println("[WiFi] WiFi1 has no internet — forcing STARLINK, 10min cooldown");
    } else {
      // STARLINK also lost internet — clear flag so WiFi1 gets a fair retry
      wifi1NoInternet=false;
      Serial.println("[WiFi] STARLINK lost internet — clearing WiFi1 block, retrying both");
    }
  }
}

/* ===================== HTTP ===================== */
// Posts JSON and returns response body (empty string on failure)
String postJSONResponse(const String& p){
  if(WiFi.status()!=WL_CONNECTED || !internetOK) return "";
  WiFiClientSecure client;
  client.setInsecure();
  client.setTimeout(12000);
  HTTPClient h;
  h.setTimeout(12000);
  if(!h.begin(client, SERVER_URL)) return "";
  h.addHeader("Content-Type","application/json");
  int c = h.POST(p);
  if(c != 200){ h.end(); return ""; }
  String body = h.getString();
  h.end();
  return body;
}

bool postJSON(const String& p){ return postJSONResponse(p).length() > 0; }

/* ===================== QUEUE ===================== */
void queueEvent(const String&p){ if(eventQueue.size() >= 100) eventQueue.pop_front(); eventQueue.push_back(p); }
void processQueue(){ static unsigned long last=0; if(otaInProgress||eventQueue.empty()||WiFi.status()!=WL_CONNECTED||!internetOK||millis()-last<5000) return; if(postJSON(eventQueue.front())) eventQueue.pop_front(); last=millis(); }

/* ===================== SYNC ===================== */
bool trySyncDaily(uint32_t d, unsigned long u) {
  if (!ntpReady || WiFi.status() != WL_CONNECTED || !internetOK) return false;
  jsonBuf = String("{\"device\":\"") + DEVICE_NAME +
            String("\",\"event\":\"DAILY_SYNC\",\"day\":") + String(d) +
            String(",\"uptime_ms\":") + String(u) + String("}");
  return postJSON(jsonBuf);
}
bool trySyncMonthly(uint32_t m, unsigned long u) {
  if (!ntpReady || WiFi.status() != WL_CONNECTED || !internetOK) return false;
  jsonBuf = String("{\"device\":\"") + DEVICE_NAME +
            String("\",\"event\":\"MONTHLY_SYNC\",\"month\":") + String(m) +
            String(",\"uptime_ms\":") + String(u) + String("}");
  return postJSON(jsonBuf);
}

/* ===================== OTA ===================== */
void reportOTA(String s,String v){ postJSON("{\"device\":\"" DEVICE_NAME "\",\"event\":\"OTA_"+s+"\",\"version\":\""+v+"\"}"); }

void finalizeUptimeBeforeOTA(){ if(!confirmed) return; unsigned long n=millis(); unsigned long s=n-onStart; dayOnMs+=s; monthOnMs+=s; prefs.putULong("dayOn",dayOnMs); prefs.putULong("monthOn",monthOnMs); confirmed=false; MIRROR_WRITE(LOW); queueEvent("{\"device\":\"" DEVICE_NAME "\",\"event\":\"OFFLINE\",\"time\":\""+timestamp()+"\"}"); processQueue(); }

void performOTA(String url, String ver){
  Serial.println("[OTA] ===== OTA START =====");
  Serial.println("[OTA] URL: " + url);
  Serial.println("[OTA] Target version: " + ver);

  otaInProgress = true;
  finalizeUptimeBeforeOTA();
  delay(500);

  WiFiClientSecure c;
  c.setInsecure();
  c.setTimeout(15000);

  HTTPClient h;
  h.setFollowRedirects(HTTPC_STRICT_FOLLOW_REDIRECTS);

  if (!h.begin(c, url)) {
    Serial.println("[OTA][ERR] h.begin failed");
    reportOTA("FAILED", ver);
    otaInProgress = false;
    return;
  }

  int httpCode = h.GET();
  Serial.print("[OTA] HTTP code: ");
  Serial.println(httpCode);
  if (httpCode != 200) {
    h.end();
    Serial.println("[OTA][ERR] HTTP not 200");
    reportOTA("FAILED", ver);
    otaInProgress = false;
    return;
  }

  int size = h.getSize();
  Serial.print("[OTA] Content-Length: ");
  Serial.println(size);

  if (size > 0) {
    if (!Update.begin(size)) {
      Serial.println("[OTA][ERR] Update.begin(size) failed");
      h.end();
      reportOTA("FAILED", ver);
      otaInProgress = false;
      return;
    }
  } else {
    if (!Update.begin(UPDATE_SIZE_UNKNOWN)) {
      Serial.println("[OTA][ERR] Update.begin(UNKNOWN) failed");
      h.end();
      reportOTA("FAILED", ver);
      otaInProgress = false;
      return;
    }
  }

  WiFiClient* s = h.getStreamPtr();
  uint8_t buf[4096];
  unsigned long lastData = millis();
  size_t totalWritten = 0;

  Serial.println("[OTA] Start streaming firmware");

  while (h.connected()) {
    if (millis() - lastData > OTA_TIMEOUT) {
      Serial.println("[OTA][ERR] OTA timeout");
      Update.abort();
      h.end();
      reportOTA("FAILED", ver);
      otaInProgress = false;
      return;
    }

    size_t avail = s->available();
    if (avail) {
      size_t r = s->readBytes(buf, min((size_t)4096, avail));
      size_t w = Update.write(buf, r);
      if (w != r) {
        Serial.print("[OTA][ERR] Write failed r=");
        Serial.print(r);
        Serial.print(" w=");
        Serial.println(w);
        Update.abort();
        h.end();
        reportOTA("FAILED", ver);
        otaInProgress = false;
        return;
      }
      totalWritten += w;
      lastData = millis();
      Serial.print("[OTA] Written ");
      Serial.print(totalWritten);
      Serial.println(" bytes");

      if (size > 0 && totalWritten >= (size_t)size) {
        Serial.println("[OTA] Firmware fully received");
        break;
      }
    } else {
      delay(10);
    }
  }

  h.end();
  Serial.println("[OTA] Stream ended, finishing update");

  if (!Update.end(true)) {
    Serial.print("[OTA][ERR] Update.end failed err=");
    Serial.println(Update.getError());
    reportOTA("FAILED", ver);
    otaInProgress = false;
    return;
  }

  Serial.println("[OTA] OTA SUCCESS, rebooting");
  reportOTA("SUCCESS", ver);
  delay(1000);
  ESP.restart();
}

/* ===================== REMOTE CONFIG ===================== */
void clearNvsConfig(){
  prefs.putBool("cfg_ok", false);
  prefs.remove("w1s"); prefs.remove("w1p");
  prefs.remove("w2s"); prefs.remove("w2p");
  Serial.println("[CFG] NVS config cleared — will re-fetch after reboot");
}

bool fetchConfig(){
  if(WiFi.status()!=WL_CONNECTED || !internetOK) return false;
  WiFiClientSecure c; c.setInsecure(); c.setTimeout(12000);
  HTTPClient h; h.setFollowRedirects(HTTPC_STRICT_FOLLOW_REDIRECTS);
  String url = String(SERVER_BASE_URL) + "/api/config/" DEVICE_NAME;
  if(!h.begin(c,url)) return false;
  int code = h.GET();
  if(code!=200){ h.end(); Serial.println("[CFG] Config fetch failed code="+String(code)); return false; }
  String body = h.getString(); h.end();
  Serial.println("[CFG] Config response: "+body);
  if(body.indexOf("\"ok\":true")<0) return false;

  auto getField=[&](const String& key)->String{
    int idx=body.indexOf(key); if(idx<0) return String();
    int q1=body.indexOf('"',idx+key.length()); if(q1<0) return String();
    int q2=body.indexOf('"',q1+1); if(q2<0) return String();
    return body.substring(q1+1,q2);
  };

  String s1=getField("\"wifi1_ssid\""), p1=getField("\"wifi1_pass\"");
  String s2=getField("\"wifi2_ssid\""), p2=getField("\"wifi2_pass\"");
  if(s1.isEmpty()||p1.isEmpty()){ Serial.println("[CFG] Missing fields in response"); return false; }

  cfgWifi1SSID=s1; cfgWifi1Pass=p1;
  cfgWifi2SSID=s2.isEmpty()?String(WIFI2_SSID):s2;
  cfgWifi2Pass=p2.isEmpty()?String(WIFI2_PASSWORD):p2;

  prefs.putString("w1s",cfgWifi1SSID); prefs.putString("w1p",cfgWifi1Pass);
  prefs.putString("w2s",cfgWifi2SSID); prefs.putString("w2p",cfgWifi2Pass);
  prefs.putBool("cfg_ok",true);
  Serial.println("[CFG] WiFi config saved to NVS: "+cfgWifi1SSID+"/"+cfgWifi2SSID);
  postJSON("{\"device\":\"" DEVICE_NAME "\",\"event\":\"WIFI_CFG_OK\","
           "\"wifi1\":\""+cfgWifi1SSID+"\",\"wifi2\":\""+cfgWifi2SSID+"\"}");
  return true;
}

// Shared: parse a JSON string field value from a flat JSON body
String parseField(const String& body, const String& key){
  int idx = body.indexOf(key);
  if(idx < 0) return String();
  int q1 = body.indexOf('"', idx + key.length());
  if(q1 < 0) return String();
  int q2 = body.indexOf('"', q1 + 1);
  if(q2 < 0) return String();
  return body.substring(q1 + 1, q2);
}

// Process a JSON body that may contain OTA or reset_config instructions.
// Used by both heartbeat response and the fallback OTA check poll.
void handleServerResponse(const String& body){
  if(body.length() == 0) return;
  if(body.indexOf("\"reset_config\":true") >= 0){
    Serial.println("[CFG] Server requested config reset — rebooting");
    clearNvsConfig();
    postJSON("{\"device\":\"" DEVICE_NAME "\",\"event\":\"WIFI_RESET\"}");
    delay(1000);
    ESP.restart();
  }
  if(body.indexOf("\"update\":true") < 0) return;
  String nv = parseField(body, "\"version\"");
  String fu = parseField(body, "\"url\"");
  if(nv.length() == 0 || fu.length() == 0){ Serial.println("[OTA][ERR] invalid firmware response"); return; }
  bool force = body.indexOf("\"force\":true") >= 0;
  if(!force && nv == FW_VERSION) return;
  Serial.println("[OTA] Parsed firmware URL: " + fu);
  performOTA(fu, nv);
}

void checkManualUpdate(){
  if(otaInProgress || WiFi.status()!=WL_CONNECTED || !internetOK) return;

  WiFiClientSecure c;
  c.setInsecure();
  c.setTimeout(15000);

  HTTPClient h;
  h.setFollowRedirects(HTTPC_STRICT_FOLLOW_REDIRECTS);
  if(!h.begin(c, String(SERVER_BASE_URL) + "/api/fw/" DEVICE_NAME)) return;

  int code = h.GET();
  if(code <= 0){
    netFailCountFW++;
    h.end();
    if(netFailCountFW >= 3){
      WiFi.disconnect(false);
      netFailCountFW = 0;
      internetOK = false;
      internetStableSince = 0;
      wifiRetryInterval = WIFI_RETRY_MS;
      lastWiFiAttempt = 0;
    }
    return;
  }
  netFailCountFW = 0;
  String body = h.getString();
  h.end();
  Serial.println("[OTA] FW response: " + body);
  handleServerResponse(body);
}

/* ===================== TRACK PIN ISR ===================== */
void IRAM_ATTR onPowerRestored() {
  powerRestoredISR = true; // signal loop() to reset WiFi backoff immediately
}

/* ===================== SETUP ===================== */
void setup() {
  jsonBuf.reserve(256);
  Serial.begin(9600);

  WiFi.mode(WIFI_STA);

  // Reset backoff the instant IP is obtained — fires asynchronously in WiFi driver,
  // not waiting for the next connectWiFi() poll. Catches router restoration immediately.
  WiFi.onEvent([](WiFiEvent_t event, WiFiEventInfo_t info) {
    wifiRetryInterval = WIFI_RETRY_MS;
    lastWiFiAttempt = 0; // allow connectWiFi() to fire immediately if called again
    Serial.println("[WiFi] IP obtained — backoff reset instantly");
  }, ARDUINO_EVENT_WIFI_STA_GOT_IP);

  const esp_partition_t* r = esp_ota_get_running_partition();
  esp_ota_img_states_t s;
  if (esp_ota_get_state_partition(r, &s) == ESP_OK &&
      s == ESP_OTA_IMG_PENDING_VERIFY) {
    esp_ota_mark_app_valid_cancel_rollback();
    queueEvent("{\"device\":\"" DEVICE_NAME "\",\"event\":\"OTA_SUCCESS\",\"version\":\"" FW_VERSION "\"}");
  }

  pinMode(TRACK_PIN, INPUT_PULLDOWN);
  pinMode(MIRROR_PIN, OUTPUT);
  attachInterrupt(digitalPinToInterrupt(TRACK_PIN), onPowerRestored, RISING);

  prefs.begin("uptime", false);

  // Load WiFi credentials from NVS BEFORE first connectWiFi() call
  if(prefs.getBool("cfg_ok", false)){
    cfgWifi1SSID = prefs.getString("w1s", WIFI1_SSID);
    cfgWifi1Pass = prefs.getString("w1p", WIFI1_PASSWORD);
    cfgWifi2SSID = prefs.getString("w2s", WIFI2_SSID);
    cfgWifi2Pass = prefs.getString("w2p", WIFI2_PASSWORD);
    cfgFetched   = true;
    Serial.println("[CFG] Loaded WiFi config from NVS: "+cfgWifi1SSID+"/"+cfgWifi2SSID);
  } else {
    Serial.println("[CFG] No NVS config — using hardcoded defaults, will fetch from server");
  }

  connectWiFi();

  configTime(
    GMT_OFFSET_SEC,
    DAYLIGHT_OFFSET,
    "pool.ntp.org",
    "time.nist.gov"
  );

  pendingDailySync = prefs.getBool("pendingDS", false);
  pendingDayEpoch = prefs.getUInt("pDay", todayEpoch());
  pendingDayUptime = prefs.getULong("pDayUp", 0);
  pendingMonthlySync = prefs.getBool("pendingMS", false);
  pendingMonthEpoch = prefs.getUInt("pMonth", monthStartEpoch());
  pendingMonthUptime = prefs.getULong("pMonthUp", 0);
  if (pendingDailySync) pendingDaySince = millis();
  if (pendingMonthlySync) pendingMonthSince = millis();

  // FW_REPORT moved to loop() after network is stable

  dayEpoch   = prefs.getUInt("day", todayEpoch());
  monthEpoch = prefs.getUInt("month", monthStartEpoch());
  dayOnMs    = prefs.getULong("dayOn", 0);
  monthOnMs  = prefs.getULong("monthOn", 0);

  confirmed = digitalRead(TRACK_PIN);
  MIRROR_WRITE(confirmed);
  if (confirmed) onStart = millis();

  setupDone = true;
}

/* ===================== LOOP ===================== */
void loop() {
  // TRACK_PIN rising edge ISR fired — power restored, reset WiFi backoff immediately
  if (powerRestoredISR && setupDone) {
    powerRestoredISR = false;
    wifiRetryInterval = WIFI_RETRY_MS;
    lastWiFiAttempt = 0;
    Serial.println("[ISR] Power restored on TRACK_PIN — WiFi backoff reset");
  }

  connectWiFi();
  updateInternetHealth();

  if (WiFi.status() == WL_CONNECTED && activeWiFi == 2 && preferWifi1Pending &&
      !wifi1NoInternet && millis() - internetStableSince > WIFI_RETURN_STABLE_MS) {
    // Attempt switch back to WiFi1 directly — no SSID scan to avoid blocking
    // the loop and disrupting the active STARLINK connection.
    // If WiFi1 is unavailable it will fail quickly and fall back to WiFi2.
    Serial.println("[WiFi] Switching back to WiFi1 to test internet");
    WiFi.disconnect(false); // false = keep NVS credentials, avoid unnecessary flash wear
    wifiPhase = 0; // next connectWiFi() tries WiFi1
    // preferWifi1Pending stays true — cleared only when WiFi1 confirms internet
  }

  ensureTime();

  // ---- Fetch WiFi config from server if NVS is empty (first boot after flash)
  // Throttled to every 60s to avoid hammering server when /setwifi was never run
  static unsigned long lastCfgFetchAttempt = 0;
  if (!cfgFetched && WiFi.status() == WL_CONNECTED && internetOK &&
      millis() - lastCfgFetchAttempt > 60000UL) {
    lastCfgFetchAttempt = millis();
    if (fetchConfig()) cfgFetched = true;
    return; // yield — avoid SSL context overlap with other calls
  }

  // ---- Delayed FW_REPORT + WIFI_CONNECTED (queue once when network is ready)
  if (!fwReportSent && WiFi.status() == WL_CONNECTED && internetOK) {
    // Single POST carries both FW_REPORT and WIFI_CONNECTED — saves one SSL handshake on boot
    Serial.println("[DIAG] Queuing BOOT_REPORT (FW + WiFi in one)");
    jsonBuf = "{\"device\":\"" DEVICE_NAME "\",\"event\":\"BOOT_REPORT\","
              "\"version\":\"" FW_VERSION "\","
              "\"ssid\":\"" + WiFi.SSID() + "\","
              "\"ip\":\"" + WiFi.localIP().toString() + "\","
              "\"time\":\"" + timestamp() + "\"}";
    queueEvent(jsonBuf);
    fwReportSent = true;
  }

  if (!otaInProgress && WiFi.status() == WL_CONNECTED && internetOK &&
      millis() - lastHeartbeat > HEARTBEAT_MS) {
    lastHeartbeat = millis();
    Serial.println("[DIAG] Sending HEARTBEAT");
    jsonBuf = "{\"device\":\"" DEVICE_NAME "\",\"event\":\"HEARTBEAT\","
              "\"ssid\":\"" + WiFi.SSID() + "\","
              "\"ip\":\"" + WiFi.localIP().toString() + "\"}";
    String hbResp = postJSONResponse(jsonBuf);
    // Piggyback: server returns OTA + reset_config in heartbeat reply — no extra SSL round trip
    if (hbResp.length() > 0) handleServerResponse(hbResp);
  }

  bool raw = digitalRead(TRACK_PIN);
  unsigned long now = millis();

  if (raw != lastStable) {
    lastStable = raw;
    lastDebounce = now;
  }

  if (now - lastDebounce > DEBOUNCE_MS) {
    if (raw != candidate) {
      candidate = raw;
      candidateSince = now;
    }

    if (now - candidateSince >= CONFIRM_MS && candidate != confirmed) {
      confirmed = candidate;
      MIRROR_WRITE(confirmed);

      if (confirmed) {
        onStart = now;
        jsonBuf = "{\"device\":\"" DEVICE_NAME "\",\"event\":\"ONLINE\",\"time\":\"" + timestamp() + "\"}";
        queueEvent(jsonBuf);
      } else {
        unsigned long sess = now - onStart;
        dayOnMs += sess;
        monthOnMs += sess;
        prefs.putULong("dayOn", dayOnMs);
        prefs.putULong("monthOn", monthOnMs);
        jsonBuf = "{\"device\":\"" DEVICE_NAME "\",\"event\":\"OFFLINE\",\"time\":\"" + timestamp() + "\"}";
        queueEvent(jsonBuf);
      }
    }
  }

  if (ntpReady) {
    // Snapshot onStart before any rollover block mutates it.
    // Both daily and monthly rollover fire on the 1st of the month;
    // without this, the monthly eff calculation sees the already-reset onStart.
    unsigned long savedOnStart = onStart;

    uint32_t t = todayEpoch();
    if (t != dayEpoch) {
      unsigned long eff = dayOnMs + (confirmed ? (now - savedOnStart) : 0);
      pendingDailySync = true;
      pendingDayEpoch = dayEpoch;
      pendingDayUptime = eff;
      pendingDaySince = millis();

      // Reset counters immediately to prevent re-inflation on next loop
      dayEpoch = t;
      dayOnMs = 0;
      if (confirmed) onStart = now;

      prefs.putBool("pendingDS", true);
      prefs.putUInt("pDay", pendingDayEpoch);
      prefs.putULong("pDayUp", pendingDayUptime);
      prefs.putUInt("day", dayEpoch);
      prefs.putULong("dayOn", 0);

      if (trySyncDaily(pendingDayEpoch, pendingDayUptime)) {
        pendingDailySync = false;
        prefs.putBool("pendingDS", false);
      }
    }

    // Retry pending daily sync (throttled to every 30s)
    static unsigned long lastDailySyncRetry = 0;
    if (pendingDailySync && millis() - lastDailySyncRetry > 30000UL) {
      lastDailySyncRetry = millis();
      if (trySyncDaily(pendingDayEpoch, pendingDayUptime)) {
        pendingDailySync = false;
        prefs.putBool("pendingDS", false);
      }
    }

    uint32_t m = monthStartEpoch();
    if (m != monthEpoch) {
      unsigned long eff = monthOnMs + (confirmed ? (now - savedOnStart) : 0);
      pendingMonthlySync = true;
      pendingMonthEpoch = monthEpoch;
      pendingMonthUptime = eff;
      pendingMonthSince = millis();

      // Reset counters immediately to prevent re-inflation on next loop
      monthEpoch = m;
      monthOnMs = 0;
      if (confirmed) onStart = now;

      prefs.putBool("pendingMS", true);
      prefs.putUInt("pMonth", pendingMonthEpoch);
      prefs.putULong("pMonthUp", pendingMonthUptime);
      prefs.putUInt("month", monthEpoch);
      prefs.putULong("monthOn", 0);

      if (trySyncMonthly(pendingMonthEpoch, pendingMonthUptime)) {
        pendingMonthlySync = false;
        prefs.putBool("pendingMS", false);
      }
    }

    // Retry pending monthly sync (throttled to every 30s)
    static unsigned long lastMonthlySyncRetry = 0;
    if (pendingMonthlySync && millis() - lastMonthlySyncRetry > 30000UL) {
      lastMonthlySyncRetry = millis();
      if (trySyncMonthly(pendingMonthEpoch, pendingMonthUptime)) {
        pendingMonthlySync = false;
        prefs.putBool("pendingMS", false);
      }
    }
  }

  if (pendingDailySync && millis() - pendingDaySince > 21600000UL) {
    pendingDailySync = false;
    prefs.putBool("pendingDS", false);
  }

  if (pendingMonthlySync && millis() - pendingMonthSince > 21600000UL) {
    pendingMonthlySync = false;
    prefs.putBool("pendingMS", false);
  }

  // Periodic NVS flush — preserve uptime across unexpected power-off
  // Include current session time so a power-cut during ONLINE doesn't lose accumulation
  static unsigned long lastNvsFlush = 0;
  if (confirmed && millis() - lastNvsFlush > 60000UL) {
    unsigned long flushNow = millis();
    lastNvsFlush = flushNow;
    unsigned long sessNow = flushNow - onStart;
    prefs.putULong("dayOn", dayOnMs + sessNow);
    prefs.putULong("monthOn", monthOnMs + sessNow);
  }

  processQueue();
  delay(10);
}
