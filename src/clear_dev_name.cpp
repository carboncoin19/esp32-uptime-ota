#include <Arduino.h>
#include <Preferences.h>

void setup() {
  Serial.begin(9600);
#if defined(ARDUINO_USB_CDC_ON_BOOT) && ARDUINO_USB_CDC_ON_BOOT
  while (!Serial) delay(10);
#endif
  Preferences prefs;
  prefs.begin("uptime", false);
  prefs.remove("dev_name");
  prefs.end();
  Serial.println("dev_name cleared — reflash your firmware now.");
}

void loop() {}
