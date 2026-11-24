# Haus-Zentrale

Grafische Seiten für ein Home-Assistant-Dashboard: Haus mit Energiefluss, Energie und Hausbatterie, Wärmepumpe mit Lüftung, Wallboxen und Hausgeräte.

Die Seiten liegen unter `/config/www/zentrale/` und werden im Dashboard als Webseiten-Karte mit `/local/zentrale/index.html?s=<seite>` eingebunden. Mögliche Seiten: `haus`, `energie`, `waerme`, `mobil`, `haushalt`.

Die Seiten lesen den Zustand aus der angemeldeten Home-Assistant-Oberfläche. Sie speichern keine Zugangsdaten und enthalten keine festen Gerätenamen. Geräte werden zur Laufzeit über Muster und Integrationen gefunden (SolarEdge Modbus, myUplink, Easee, Miele, Home Connect, Shelly, Uptime Kuma).

## Aktualisieren

In `configuration.yaml`:

```yaml
shell_command:
  zentrale_aktualisieren: "mkdir -p /config/www/zentrale && curl -fsSL https://codeload.github.com/TuckTuck13/haus-zentrale/tar.gz/main | tar -xz -C /config/www/zentrale --strip-components=3 haus-zentrale-main/www/zentrale"
```

Danach genügt der Dienst `shell_command.zentrale_aktualisieren`.
