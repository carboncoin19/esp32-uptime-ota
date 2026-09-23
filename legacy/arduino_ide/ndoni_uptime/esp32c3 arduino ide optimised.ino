// ======================================================
// NDONI ESP32 UPTIME FIRMWARE — ARDUINO IDE VERSION
// v1.0.30 | Target: ESP32-C3 Universal / Dev Module
// ======================================================
// Arduino IDE Board Settings (Tools menu):
//   Board            : ESP32C3 Dev Module
//   USB CDC On Boot  : Enabled       ← required for Serial to work
//   CPU Frequency    : 160MHz
//   Flash Mode       : QIO 80MHz
//   Flash Size       : 4MB (32Mb)
//   Partition Scheme : Default 4MB with spiffs
//   Upload Speed     : 115200
// ======================================================

// ---- WiFi credentials — edit before flashing ----
#define WIFI1_SSID     "Mifi"
#define WIFI1_PASSWORD "12345678"
#define WIFI2_SSID     "MifI"
#define WIFI2_PASSWORD "12345678"

// ---- Device name — uncomment to skip the serial prompt on first boot ----
// Must match TG_BOT_DEVICE_N on Railway (e.g. NDONI-UPTIME).
// Leave commented to enter the name via Serial Monitor on first boot.
#define DEFAULT_DEVICE_NAME "OBRIKOME_BOT"

// ---- Pin assignments for ESP32-C3 ----
// GPIO 27 does not exist on ESP32-C3 — TRACK_PIN defaulted to GPIO 6.
// Change TRACK_PIN to match your hardware wiring.
#define TRACK_PIN   10   // sensor input
#define MIRROR_PIN  8    // mirror output (active HIGH)
// For active-LOW mirror output, replace (v) with !(v) in the line below:
#define MIRROR_WRITE(v) digitalWrite(MIRROR_PIN, (v))

// ======================================================

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
String deviceName;
#define FW_VERSION  "1.0.30"

/* ===================== TIMING ===================== */
#define DEBOUNCE_MS       50
#define CONFIRM_MS        10000UL
#define HEARTBEAT_MS      120000UL
#define WIFI_RETRY_MS     10000UL
#define WIFI_RETRY_MAX_MS 300000UL
#define OTA_TIMEOUT       60000UL

/* ===================== NETWORK ===================== */
#define SERVER_BASE_URL     "https://uptime-bot-production-9a37.up.railway.app"
#define SERVER_URL          SERVER_BASE_URL "/api/event"
#define NET_CHECK_MS        60000UL
#define NET_FAIL_THRESHOLD  6
#define NET_HTTP_TIMEOUT_MS 20000

#define WIFI_RETURN_STABLE_MS 60000UL

/* ===================== TIME ===================== */
#define GMT_OFFSET_SEC  3600
#define DAYLIGHT_OFFSET 0

/* ===================== GLOBAL OBJECTS ===================== */
Preferences prefs;
std::deque<String> eventQueue;
String jsonBuf;

/* ===================== RUNTIME WIFI CONFIG ===================== */
String cfgWifi1SSID = WIFI1_SSID;
String cfgWifi1Pass = WIFI1_PASSWORD;
String cfgWifi2SSID = WIFI2_SSID;
String cfgWifi2Pass = WIFI2_PASSWORD;
bool   cfgFetched   = false;

/* ===================== RUNTIME STATE ===================== */
bool lastStable=false, candidate=false, confirmed=false;
bool internetOK=false, ntpReady=false;
volatile bool otaInProgress=false;
volatile bool setupDone=false;
bool preferWifi1Pending=false;
bool wifi1NoInternet=false;
bool pendingDailySync=false, pendingMonthlySync=false;
bool fwReportSent=false;

uint8_t activeWiFi=0;
uint8_t wifiPhase=0;
uint8_t netFailCount=0;
uint8_t noSsidMissCount=0;
bool inConnectRoutine=false;

unsigned long wifiRetryInterval = WIFI_RETRY_MS;

unsigned long lastDebounce=0, candidateSince=0, onStart=0;
unsigned long lastWiFiAttempt=0, lastHeartbeat=0;
unsigned long lastNetCheck=0, internetStableSince=0;
bool firstNetCheck=true;
unsigned long pendingDaySince=0, pendingMonthSince=0;

unsigned long dayOnMs=0, monthOnMs=0;
unsigned long pendingDayUptime=0, pendingMonthUptime=0;

uint32_t dayEpoch=0, monthEpoch=0;
uint32_t pendingDayEpoch=0, pendingMonthEpoch=0;

/* ===================== TIME HELPERS ===================== */
bool timeReady(){ time_t now; time(&now); return now > 1700000000; }

uint32_t todayEpoch(){
  if(!timeReady()) return dayEpoch;
  time_t n; time(&n); struct tm t; localtime_r(&n,&t);
  t.tm_hour=t.tm_min=t.tm_sec=0; return mktime(&t);
}
uint32_t monthStartEpoch(){
  if(!timeReady()) return monthEpoch;
  time_t n; time(&n); struct tm t; localtime_r(&n,&t);
  t.tm_mday=1; t.tm_hour=t.tm_min=t.tm_sec=0; return mktime(&t);
}
String timestamp(){
  struct tm t;
  if(!getLocalTime(&t)) return String(time(NULL));
  char b[32]; strftime(b,sizeof(b),"%b %d %Y %I:%M:%S %p",&t); return String(b);
}
void ensureTime(){ if(!ntpReady && timeReady()) ntpReady=true; }

/* ===================== WIFI HELPERS ===================== */
void connectWiFi(){
  if (WiFi.status() == WL_CONNECTED) {
    if (wifiRetryInterval != WIFI_RETRY_MS) {
      wifiRetryInterval = WIFI_RETRY_MS;
      Serial.println("[WiFi] Connected — backoff reset to 10s");
    }
    return;
  }
  if (otaInProgress) return;
  if (millis() - lastWiFiAttempt < wifiRetryInterval) return;
  lastWiFiAttempt = millis();

  const char* ssid = (wifiPhase == 0) ? cfgWifi1SSID.c_str() : cfgWifi2SSID.c_str();
  const char* pass = (wifiPhase == 0) ? cfgWifi1Pass.c_str() : cfgWifi2Pass.c_str();

  if (!ssid || strlen(ssid) == 0 || strlen(ssid) > 32) {
    Serial.println("[WiFi][ERR] Invalid SSID config, skipping");
    wifiPhase = (wifiPhase + 1) % 2;
    return;
  }

  Serial.print("[WiFi] Connecting to ");
  Serial.println(ssid);

  inConnectRoutine = true;

  static uint8_t hardResetCounter = 0;
  if (++hardResetCounter >= 5) {
    hardResetCounter = 0;
    Serial.println("[WiFi][DBG] hard reset (radio off/on)");
    WiFi.disconnect(true);
    WiFi.mode(WIFI_OFF);
    delay(300);
    WiFi.mode(WIFI_STA);
    delay(100);
  } else {
    Serial.print("[WiFi][DBG] soft reset (attempt, hardReset in ");
    Serial.print(5 - hardResetCounter);
    Serial.println(")");
    WiFi.disconnect(true);
    delay(100);
  }

  bool connected = false;
  bool hardFail  = false;

  for (int attempt = 1; attempt <= 4 && !connected && !hardFail; attempt++) {
    if (attempt > 1) {
      Serial.print("[WiFi] NO_SSID_AVAIL — retry ");
      Serial.println(attempt);
      WiFi.disconnect(true);
      delay(1500);
    }
    WiFi.begin(ssid, pass);
    activeWiFi = (wifiPhase == 0) ? 1 : 2;

    unsigned long t = millis();
    while (millis() - t < 15000) {
      delay(500);
      wl_status_t st = WiFi.status();
      if (st == WL_CONNECTED) {
        Serial.println("[WiFi] Connected! IP: " + WiFi.localIP().toString());
        wifiRetryInterval = WIFI_RETRY_MS;
        connected = true;
        break;
      }
      if (st == WL_CONNECT_FAILED)  { Serial.println("[WiFi][ERR] CONNECT_FAILED"); hardFail = true; break; }
      if (st == WL_NO_SSID_AVAIL)   { Serial.println("[WiFi][ERR] NO_SSID_AVAIL"); break; }
      if (st == WL_CONNECTION_LOST) { Serial.println("[WiFi][ERR] CONNECTION_LOST"); hardFail = true; break; }
    }
  }

  if (WiFi.status() == WL_CONNECTED) { inConnectRoutine = false; return; }

  inConnectRoutine = false;
  Serial.print("[WiFi][ERR] Failed, status=");
  Serial.println(WiFi.status());

  bool switchPhase;
  if (hardFail) {
    switchPhase = true;
    noSsidMissCount = 0;
  } else {
    noSsidMissCount++;
    switchPhase = (noSsidMissCount >= 3);
    if (switchPhase) {
      noSsidMissCount = 0;
    } else {
      Serial.print("[WiFi] SSID miss ");
      Serial.print(noSsidMissCount);
      Serial.println("/3 — retrying same network");
    }
  }

  if (switchPhase) {
    wifiPhase = (wifiPhase + 1) % 2;
    Serial.println("[WiFi] Switching to other network");
  }

  wifiRetryInterval = min(wifiRetryInterval * 3 / 2, WIFI_RETRY_MAX_MS);
  Serial.print("[WiFi] Next retry in ");
  Serial.print(wifiRetryInterval / 1000);
  Serial.println("s");
}

bool checkInternetOnce(){
  if(WiFi.status()!=WL_CONNECTED) return false;
  IPAddress ip;
  if(!WiFi.hostByName("connectivitycheck.gstatic.com", ip)) return false;
  HTTPClient h; h.setTimeout(NET_HTTP_TIMEOUT_MS);
  h.begin("http://connectivitycheck.gstatic.com/generate_204");
  int c=h.GET(); h.end(); return c==204;
}

void updateInternetHealth(){
  if(!firstNetCheck && millis()-lastNetCheck<NET_CHECK_MS) return;
  firstNetCheck=false;
  lastNetCheck=millis();
  bool ok=checkInternetOnce();
  if(ok){
    if(!internetOK && activeWiFi==2){
      internetStableSince=millis();
      preferWifi1Pending=true;
    }
    if(activeWiFi==1){
      preferWifi1Pending=false;
      wifi1NoInternet=false;
    }
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
      wifi1NoInternet=true;
      wifiPhase=1;
      Serial.println("[WiFi] WiFi1 has no internet — forcing STARLINK, 10min cooldown");
    } else {
      wifi1NoInternet=false;
      Serial.println("[WiFi] STARLINK lost internet — clearing WiFi1 block, retrying both");
    }
  }
}

/* ===================== HTTP ===================== */
bool dnsReachable(){
  IPAddress ip;
  bool ok = WiFi.hostByName("uptime-bot-production-9a37.up.railway.app", ip);
  if(!ok) Serial.println("[NET] DNS failed — skipping HTTP, will retry next cycle");
  return ok;
}

String postJSONResponse(const String& p){
  if(WiFi.status()!=WL_CONNECTED || !internetOK) return "";
  if(!dnsReachable()) return "";
  WiFiClientSecure client;
  client.setInsecure();
  client.setTimeout(NET_HTTP_TIMEOUT_MS);
  HTTPClient h;
  h.setTimeout(NET_HTTP_TIMEOUT_MS);
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
void queueEvent(const String& p){
  if(eventQueue.size() >= 100) eventQueue.pop_front();
  eventQueue.push_back(p);
}
void processQueue(){
  static unsigned long last=0;
  if(otaInProgress||eventQueue.empty()||WiFi.status()!=WL_CONNECTED||!internetOK||millis()-last<5000) return;
  if(postJSON(eventQueue.front())) eventQueue.pop_front();
  last=millis();
}

/* ===================== SYNC ===================== */
bool trySyncDaily(uint32_t d, unsigned long u){
  if(!ntpReady || WiFi.status()!=WL_CONNECTED || !internetOK) return false;
  jsonBuf = String("{\"device\":\"") + deviceName +
            "\",\"event\":\"DAILY_SYNC\",\"day\":" + String(d) +
            ",\"uptime_ms\":" + String(u) + "}";
  return postJSON(jsonBuf);
}
bool trySyncMonthly(uint32_t m, unsigned long u){
  if(!ntpReady || WiFi.status()!=WL_CONNECTED || !internetOK) return false;
  jsonBuf = String("{\"device\":\"") + deviceName +
            "\",\"event\":\"MONTHLY_SYNC\",\"month\":" + String(m) +
            ",\"uptime_ms\":" + String(u) + "}";
  return postJSON(jsonBuf);
}

/* ===================== OTA ===================== */
void reportOTA(String s, String v){
  postJSON("{\"device\":\"" + deviceName + "\",\"event\":\"OTA_"+s+"\",\"version\":\""+v+"\"}");
}

void finalizeUptimeBeforeOTA(){
  if(!confirmed) return;
  unsigned long n=millis();
  unsigned long s=(n>=onStart)?(n-onStart):0;
  dayOnMs+=s; monthOnMs+=s;
  prefs.putULong("dayOn",dayOnMs);
  prefs.putULong("monthOn",monthOnMs);
  confirmed=false;
  MIRROR_WRITE(LOW);
  queueEvent("{\"device\":\"" + deviceName + "\",\"event\":\"OFFLINE\",\"time\":\""+timestamp()+"\"}");
  processQueue();
}

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
    reportOTA("FAILED", ver); otaInProgress = false; return;
  }

  int httpCode = h.GET();
  Serial.print("[OTA] HTTP code: "); Serial.println(httpCode);
  if (httpCode != 200) {
    h.end();
    Serial.println("[OTA][ERR] HTTP not 200");
    reportOTA("FAILED", ver); otaInProgress = false; return;
  }

  int size = h.getSize();
  Serial.print("[OTA] Content-Length: "); Serial.println(size);

  if (size > 0) {
    if (!Update.begin(size)) {
      Serial.println("[OTA][ERR] Update.begin(size) failed");
      h.end(); reportOTA("FAILED", ver); otaInProgress = false; return;
    }
  } else {
    if (!Update.begin(UPDATE_SIZE_UNKNOWN)) {
      Serial.println("[OTA][ERR] Update.begin(UNKNOWN) failed");
      h.end(); reportOTA("FAILED", ver); otaInProgress = false; return;
    }
  }

  WiFiClient* s = h.getStreamPtr();
  uint8_t* buf = (uint8_t*)malloc(4096);
  if (!buf) {
    Serial.println("[OTA][ERR] malloc failed");
    h.end(); reportOTA("FAILED", ver); otaInProgress = false; return;
  }
  unsigned long lastData = millis();
  size_t totalWritten = 0;
  Serial.println("[OTA] Start streaming firmware");

  while (h.connected()) {
    if (millis() - lastData > OTA_TIMEOUT) {
      Serial.println("[OTA][ERR] OTA timeout");
      Update.abort(); h.end(); free(buf);
      reportOTA("FAILED", ver); otaInProgress = false; return;
    }
    size_t avail = s->available();
    if (avail) {
      size_t r = s->readBytes(buf, min((size_t)4096, avail));
      size_t w = Update.write(buf, r);
      if (w != r) {
        Serial.print("[OTA][ERR] Write failed r="); Serial.print(r);
        Serial.print(" w="); Serial.println(w);
        Update.abort(); h.end(); free(buf);
        reportOTA("FAILED", ver); otaInProgress = false; return;
      }
      totalWritten += w;
      lastData = millis();
      Serial.print("[OTA] Written "); Serial.print(totalWritten); Serial.println(" bytes");
      if (size > 0 && totalWritten >= (size_t)size) {
        Serial.println("[OTA] Firmware fully received"); break;
      }
    } else {
      delay(10);
    }
  }

  h.end(); free(buf);
  Serial.println("[OTA] Stream ended, finishing update");

  if (!Update.end(true)) {
    Serial.print("[OTA][ERR] Update.end failed err="); Serial.println(Update.getError());
    reportOTA("FAILED", ver); otaInProgress = false; return;
  }

  Serial.println("[OTA] OTA SUCCESS, rebooting");
  reportOTA("SUCCESS", ver);
  delay(1000);
  ESP.restart();
}

/* ===================== REMOTE CONFIG ===================== */
String parseField(const String& body, const String& key){
  int idx = body.indexOf(key);
  if(idx < 0) return String();
  int q1 = body.indexOf('"', idx + key.length());
  if(q1 < 0) return String();
  int q2 = body.indexOf('"', q1 + 1);
  if(q2 < 0) return String();
  return body.substring(q1 + 1, q2);
}

void clearNvsConfig(){
  prefs.putBool("cfg_ok", false);
  prefs.remove("w1s"); prefs.remove("w1p");
  prefs.remove("w2s"); prefs.remove("w2p");
  Serial.println("[CFG] NVS config cleared — will re-fetch after reboot");
}

bool fetchConfig(){
  if(WiFi.status()!=WL_CONNECTED || !internetOK) return false;
  if(!dnsReachable()) return false;
  WiFiClientSecure c; c.setInsecure(); c.setTimeout(NET_HTTP_TIMEOUT_MS);
  HTTPClient h; h.setFollowRedirects(HTTPC_STRICT_FOLLOW_REDIRECTS);
  String url = String(SERVER_BASE_URL) + "/api/config/" + deviceName;
  if(!h.begin(c,url)) return false;
  int code = h.GET();
  if(code!=200){
    h.end();
    Serial.println("[CFG] Config fetch failed code="+String(code));
    queueEvent("{\"device\":\"" + deviceName + "\",\"event\":\"WIFI_CFG_FAIL\",\"reason\":\"http_"+String(code)+"\"}");
    return false;
  }
  String body = h.getString(); h.end();
  Serial.println("[CFG] Config response: "+body);
  if(body.indexOf("\"ok\":true")<0){
    Serial.println("[CFG] Server returned ok:false");
    queueEvent("{\"device\":\"" + deviceName + "\",\"event\":\"WIFI_CFG_FAIL\",\"reason\":\"no_config\"}");
    return false;
  }
  String s1=parseField(body,"\"wifi1_ssid\""), p1=parseField(body,"\"wifi1_pass\"");
  String s2=parseField(body,"\"wifi2_ssid\""), p2=parseField(body,"\"wifi2_pass\"");
  if(s1.isEmpty()||p1.isEmpty()){ Serial.println("[CFG] Missing fields in response"); return false; }

  cfgWifi1SSID=s1; cfgWifi1Pass=p1;
  cfgWifi2SSID=s2.isEmpty()?String(WIFI2_SSID):s2;
  cfgWifi2Pass=p2.isEmpty()?String(WIFI2_PASSWORD):p2;

  prefs.putString("w1s",cfgWifi1SSID); prefs.putString("w1p",cfgWifi1Pass);
  prefs.putString("w2s",cfgWifi2SSID); prefs.putString("w2p",cfgWifi2Pass);
  prefs.putBool("cfg_ok",true);
  Serial.println("[CFG] WiFi config saved to NVS: "+cfgWifi1SSID+"/"+cfgWifi2SSID);
  queueEvent("{\"device\":\"" + deviceName + "\",\"event\":\"WIFI_CFG_OK\","
             "\"wifi1\":\""+cfgWifi1SSID+"\",\"wifi2\":\""+cfgWifi2SSID+"\"}");
  return true;
}

void handleServerResponse(const String& body){
  if(body.length() == 0) return;
  if(body.indexOf("\"reset_config\":true") >= 0){
    Serial.println("[CFG] Server requested config reset — rebooting");
    clearNvsConfig();
    postJSON("{\"device\":\"" + deviceName + "\",\"event\":\"WIFI_RESET\"}");
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

/* ===================== SETUP ===================== */
void setup() {
  jsonBuf.reserve(256);
  Serial.begin(9600);
  // Wait up to 2s for USB CDC Serial to come up (required with "USB CDC On Boot: Enabled")
  { unsigned long _t = millis(); while (!Serial && millis() - _t < 2000) delay(10); }

  WiFi.mode(WIFI_STA);
  WiFi.persistent(false);
  WiFi.setAutoReconnect(false);
  WiFi.setSleep(false);
  WiFi.setTxPower(WIFI_POWER_11dBm); // reduce TX peak — critical for ESP32-C3 Super Mini LDO

  WiFi.onEvent([](WiFiEvent_t event, WiFiEventInfo_t info) {
    wifiRetryInterval = WIFI_RETRY_MS;
    lastWiFiAttempt = 0;
    firstNetCheck = true;
    Serial.println("[WiFi] IP obtained — backoff reset instantly");
  }, ARDUINO_EVENT_WIFI_STA_GOT_IP);

  WiFi.onEvent([](WiFiEvent_t event, WiFiEventInfo_t info) {
    if (inConnectRoutine) {
      Serial.println("[WiFi][DBG] disconnect during connect routine — suppressed");
      return;
    }
    lastWiFiAttempt   = 0;
    wifiRetryInterval = WIFI_RETRY_MS;
    noSsidMissCount   = 0;
    Serial.println("[WiFi] Disconnected mid-session — backoff reset for immediate retry");
  }, ARDUINO_EVENT_WIFI_STA_DISCONNECTED);

  pinMode(TRACK_PIN, INPUT_PULLDOWN);
  pinMode(MIRROR_PIN, OUTPUT);

  prefs.begin("uptime", false);

  deviceName = prefs.getString("dev_name", "");
  if (deviceName.isEmpty()) {
#ifdef DEFAULT_DEVICE_NAME
    deviceName = DEFAULT_DEVICE_NAME;
    prefs.putString("dev_name", deviceName);
    Serial.println("[CFG] Device name set from build default: " + deviceName);
#else
    Serial.println("\n=== DEVICE NOT CONFIGURED ===");
    Serial.println("Open Serial Monitor at 115200 baud, type device name, press Enter.");
    Serial.println("Must match TG_BOT_DEVICE_N on Railway (e.g. NDONI-UPTIME):");
    {
      unsigned long nameDeadline = millis() + 60000UL;
      while (millis() < nameDeadline) {
        if (Serial.available()) {
          String input = Serial.readStringUntil('\n');
          input.trim();
          if (input.length() > 0 && input.length() <= 32) {
            deviceName = input;
            prefs.putString("dev_name", deviceName);
            Serial.println("Saved: " + deviceName + " — rebooting...");
            delay(500);
            ESP.restart();
          } else {
            Serial.println("Invalid name (1-32 chars). Try again:");
            nameDeadline = millis() + 60000UL;
          }
        }
        delay(50);
      }
      Serial.println("[CFG] No name entered within 60s — rebooting...");
      delay(1000);
      ESP.restart();
    }
#endif
  }
  Serial.println("[CFG] Device name: " + deviceName);

  {
    const esp_partition_t* r = esp_ota_get_running_partition();
    esp_ota_img_states_t s;
    if (esp_ota_get_state_partition(r, &s) == ESP_OK &&
        s == ESP_OTA_IMG_PENDING_VERIFY) {
      esp_ota_mark_app_valid_cancel_rollback();
      queueEvent("{\"device\":\"" + deviceName + "\",\"event\":\"OTA_SUCCESS\",\"version\":\"" FW_VERSION "\"}");
    }
  }

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

  configTime(GMT_OFFSET_SEC, DAYLIGHT_OFFSET, "pool.ntp.org", "time.nist.gov");

  pendingDailySync   = prefs.getBool("pendingDS", false);
  pendingDayEpoch    = prefs.getUInt("pDay", todayEpoch());
  pendingDayUptime   = prefs.getULong("pDayUp", 0);
  pendingMonthlySync = prefs.getBool("pendingMS", false);
  pendingMonthEpoch  = prefs.getUInt("pMonth", monthStartEpoch());
  pendingMonthUptime = prefs.getULong("pMonthUp", 0);
  if (pendingDailySync)   pendingDaySince   = millis();
  if (pendingMonthlySync) pendingMonthSince = millis();

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
  connectWiFi();
  updateInternetHealth();

  if (WiFi.status() == WL_CONNECTED && activeWiFi == 2 && preferWifi1Pending &&
      !wifi1NoInternet && millis() - internetStableSince > WIFI_RETURN_STABLE_MS) {
    Serial.println("[WiFi] Switching back to WiFi1 to test internet");
    WiFi.disconnect(false);
    wifiPhase = 0;
    lastWiFiAttempt = 0;
  }

  ensureTime();

  static unsigned long lastCfgFetchAttempt = 0;
  if (!cfgFetched && WiFi.status() == WL_CONNECTED && internetOK &&
      millis() - lastCfgFetchAttempt > 60000UL) {
    lastCfgFetchAttempt = millis();
    if (fetchConfig()) cfgFetched = true;
    return;
  }

  if (!fwReportSent && WiFi.status() == WL_CONNECTED && internetOK) {
    Serial.println("[DIAG] Queuing BOOT_REPORT (FW + WiFi in one)");
    jsonBuf = "{\"device\":\"" + deviceName + "\",\"event\":\"BOOT_REPORT\","
              "\"version\":\"" FW_VERSION "\","
              "\"ssid\":\"" + WiFi.SSID() + "\","
              "\"ip\":\"" + WiFi.localIP().toString() + "\","
              "\"time\":\"" + timestamp() + "\"}";
    queueEvent(jsonBuf);
    if (confirmed) {
      Serial.println("[DIAG] TRACK_PIN HIGH on boot — queuing ONLINE");
      queueEvent("{\"device\":\"" + deviceName + "\",\"event\":\"ONLINE\",\"time\":\"" + timestamp() + "\"}");
    }
    fwReportSent = true;
  }

  bool didNetworkCall = false;

  if (!otaInProgress && WiFi.status() == WL_CONNECTED && internetOK &&
      millis() - lastHeartbeat > HEARTBEAT_MS) {
    lastHeartbeat = millis();
    Serial.println("[DIAG] Sending HEARTBEAT");
    jsonBuf = "{\"device\":\"" + deviceName + "\",\"event\":\"HEARTBEAT\","
              "\"ssid\":\"" + WiFi.SSID() + "\","
              "\"ip\":\"" + WiFi.localIP().toString() + "\","
              "\"site\":" + (confirmed ? "1" : "0") + "}";
    String hbResp = postJSONResponse(jsonBuf);
    if (hbResp.length() > 0) handleServerResponse(hbResp);
    didNetworkCall = true;
  }

  bool raw = digitalRead(TRACK_PIN);
  unsigned long now = millis();

  if (raw != lastStable) { lastStable = raw; lastDebounce = now; }

  if (now - lastDebounce > DEBOUNCE_MS) {
    if (raw != candidate) { candidate = raw; candidateSince = now; }

    if (now - candidateSince >= CONFIRM_MS && candidate != confirmed) {
      confirmed = candidate;
      MIRROR_WRITE(confirmed);

      if (confirmed) {
        onStart = now;
        wifiRetryInterval = WIFI_RETRY_MS;
        lastWiFiAttempt = 0;
        jsonBuf = "{\"device\":\"" + deviceName + "\",\"event\":\"ONLINE\",\"time\":\"" + timestamp() + "\"}";
        queueEvent(jsonBuf);
      } else {
        unsigned long sess = (now >= onStart) ? (now - onStart) : 0;
        dayOnMs += sess; monthOnMs += sess;
        prefs.putULong("dayOn", dayOnMs);
        prefs.putULong("monthOn", monthOnMs);
        jsonBuf = "{\"device\":\"" + deviceName + "\",\"event\":\"OFFLINE\",\"time\":\"" + timestamp() + "\"}";
        queueEvent(jsonBuf);
      }
    }
  }

  if (ntpReady && !didNetworkCall) {
    unsigned long savedOnStart = onStart;

    uint32_t t = todayEpoch();
    if (t != dayEpoch) {
      unsigned long eff = dayOnMs + (confirmed ? (now - savedOnStart) : 0);
      pendingDailySync = true; pendingDayEpoch = dayEpoch;
      pendingDayUptime = eff; pendingDaySince = millis();
      dayEpoch = t; dayOnMs = 0;
      if (confirmed) onStart = now;
      prefs.putBool("pendingDS", true); prefs.putUInt("pDay", pendingDayEpoch);
      prefs.putULong("pDayUp", pendingDayUptime); prefs.putUInt("day", dayEpoch);
      prefs.putULong("dayOn", 0);
      if (trySyncDaily(pendingDayEpoch, pendingDayUptime)) {
        pendingDailySync = false; prefs.putBool("pendingDS", false);
      }
    }

    static unsigned long lastDailySyncRetry = 0;
    if (pendingDailySync && millis() - lastDailySyncRetry > 30000UL) {
      lastDailySyncRetry = millis();
      if (trySyncDaily(pendingDayEpoch, pendingDayUptime)) {
        pendingDailySync = false; prefs.putBool("pendingDS", false);
      }
    }

    uint32_t m = monthStartEpoch();
    if (m != monthEpoch) {
      unsigned long eff = monthOnMs + (confirmed ? (now - savedOnStart) : 0);
      pendingMonthlySync = true; pendingMonthEpoch = monthEpoch;
      pendingMonthUptime = eff; pendingMonthSince = millis();
      monthEpoch = m; monthOnMs = 0;
      if (confirmed) onStart = now;
      prefs.putBool("pendingMS", true); prefs.putUInt("pMonth", pendingMonthEpoch);
      prefs.putULong("pMonthUp", pendingMonthUptime); prefs.putUInt("month", monthEpoch);
      prefs.putULong("monthOn", 0);
      if (trySyncMonthly(pendingMonthEpoch, pendingMonthUptime)) {
        pendingMonthlySync = false; prefs.putBool("pendingMS", false);
      }
    }

    static unsigned long lastMonthlySyncRetry = 0;
    if (pendingMonthlySync && millis() - lastMonthlySyncRetry > 30000UL) {
      lastMonthlySyncRetry = millis();
      if (trySyncMonthly(pendingMonthEpoch, pendingMonthUptime)) {
        pendingMonthlySync = false; prefs.putBool("pendingMS", false);
      }
    }
  }

  if (pendingDailySync && millis() - pendingDaySince > 21600000UL) {
    Serial.println("[SYNC] DAILY_SYNC abandoned after 6h — epoch " + String(pendingDayEpoch));
    pendingDailySync = false; prefs.putBool("pendingDS", false);
  }
  if (pendingMonthlySync && millis() - pendingMonthSince > 21600000UL) {
    Serial.println("[SYNC] MONTHLY_SYNC abandoned after 6h — epoch " + String(pendingMonthEpoch));
    pendingMonthlySync = false; prefs.putBool("pendingMS", false);
  }

  static unsigned long lastNvsFlush = 0;
  if (confirmed && millis() - lastNvsFlush > 60000UL) {
    unsigned long flushNow = millis();
    lastNvsFlush = flushNow;
    unsigned long sessNow = (flushNow >= onStart) ? (flushNow - onStart) : 0;
    prefs.putULong("dayOn", dayOnMs + sessNow);
    prefs.putULong("monthOn", monthOnMs + sessNow);
  }

  processQueue();
  delay(10);
}
