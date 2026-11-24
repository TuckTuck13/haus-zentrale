/* Haus-Zentrale: grafische Seiten für das Home-Assistant-Dashboard.
 * Läuft als iframe unter /local/zentrale/ und liest den Zustand direkt aus der
 * angemeldeten Home-Assistant-Oberfläche (gleiche Herkunft). Es werden keine
 * Zugangsdaten gespeichert; alle Geräte werden zur Laufzeit gesucht.
 */
(() => {
  'use strict';

  const P = window.parent;
  const app = document.getElementById('app');
  const SEITE = new URLSearchParams(location.search).get('s') || 'haus';
  let hass = null;
  let letzterHass = null;
  let letztesHtml = '';
  let historie = null;
  let historieZeit = 0;

  // ---------------------------------------------------------------- Grundlagen

  const haEl = () => P.document.querySelector('home-assistant');
  const st = id => (id && hass.states[id]) || null;
  const alle = () => Object.keys(hass.states);
  const finde = re => alle().find(e => re.test(e)) || null;
  const findeAlle = re => alle().filter(e => re.test(e));
  const reg = id => (hass.entities && hass.entities[id]) || {};
  const geraet = id => (hass.devices && hass.devices[reg(id).device_id]) || {};
  const bereichVon = id => reg(id).area_id || geraet(id).area_id || null;
  const nameVon = id => { const s = st(id); return (s && s.attributes.friendly_name) || id; };
  const geraeteName = d => (d && (d.name_by_user || d.name)) || '';
  const zahl = id => { const s = st(id); if (!s) return null; const v = parseFloat(s.state); return Number.isFinite(v) ? v : null; };
  const nutzbar = id => { const s = st(id); return !!s && !['unavailable', 'unknown'].includes(s.state); };
  const esc = t => String(t == null ? '' : t).replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
  const KA = 'k. A.';

  // Leistung immer in Watt, egal ob der Sensor W oder kW liefert.
  const watt = id => {
    const v = zahl(id); if (v == null) return null;
    const u = (st(id).attributes.unit_of_measurement || '').toLowerCase();
    return u === 'kw' ? v * 1000 : u === 'mw' ? v * 1e6 : v;
  };
  const fz = (v, d = 1) => v == null ? KA : v.toLocaleString('de-DE', {minimumFractionDigits: d, maximumFractionDigits: d});
  const fw = w => {
    if (w == null) return KA;
    const a = Math.abs(w);
    if (a < 1000) return Math.round(w) + ' W';
    return fz(w / 1000, a < 10000 ? 1 : 0) + ' kW';
  };
  const fwh = kwh => kwh == null ? KA : (kwh < 10 ? fz(kwh, 1) : fz(kwh, 0)) + ' kWh';
  const ft = v => v == null ? KA : fz(v, 1) + ' °C';
  const uhr = d => d.toLocaleTimeString('de-DE', {hour: '2-digit', minute: '2-digit'});
  const dauer = min => {
    if (min == null || !Number.isFinite(min)) return KA;
    min = Math.max(0, Math.round(min));
    const h = Math.floor(min / 60), m = min % 60;
    return h ? `${h} h ${String(m).padStart(2, '0')} min` : `${m} min`;
  };
  const rund = (v, s) => v == null ? null : Math.round(v / s) * s;

  const dienst = (domain, service, data) => hass.callService(domain, service, data);
  const mehr = entityId => haEl().dispatchEvent(new CustomEvent('hass-more-info', {detail: {entityId}, bubbles: true, composed: true}));
  const basis = () => '/' + (P.location.pathname.split('/')[1] || 'haus-zentrale');
  const gehe = pfad => {
    const ziel = pfad.startsWith('/') ? pfad : basis() + '/' + pfad;
    P.history.pushState(null, '', ziel);
    P.dispatchEvent(new CustomEvent('location-changed', {detail: {replace: false}}));
  };

  // ---------------------------------------------------------------- Rollen

  // Welche Sensoren was bedeuten. Nur Muster, keine festen Namen.
  const E = {};
  function rollen() {
    E.pvAc = finde(/^sensor\.solaredge_(?!modbus)[a-z0-9]+_leistung$/);
    E.pvDc = finde(/^sensor\.solaredge_(?!modbus)[a-z0-9]+_dc_leistung$/);
    E.wr = finde(/^sensor\.solaredge_(?!modbus)[a-z0-9]+_status$/);
    E.wrTemp = finde(/^sensor\.solaredge_(?!modbus)[a-z0-9]+_temperatur$/);
    E.netz = finde(/^sensor\.meter_\d+_leistung$/);
    E.batP = finde(/^sensor\.battery_\d+_dc_leistung$/);
    E.soc = finde(/^sensor\.battery_\d+_energiezustand$/);
    E.batKap = finde(/^sensor\.battery_\d+_nennleistung$/);
    E.batStatus = finde(/^sensor\.battery_\d+_status$/);
    E.batSoh = finde(/^sensor\.battery_\d+_zustandsbewertung$/);
    E.batTemp = finde(/^sensor\.battery_\d+_temperatur$/);
    E.reserve = finde(/^number\.solaredge_[a-z0-9]+_backup_reserve$/);
    const nibe = s => finde(new RegExp('^[a-z_]+\\.[a-z0-9_]*' + s + '$'));
    E.wpLeistung = nibe('_el_current_power_consumption');
    E.aussen = finde(/^sensor\.[a-z0-9_]*_outdoor_temperature$/);
    E.raum = nibe('_room_temperature_bt50');
    E.vorlauf = nibe('_supply_line_bt2');
    E.ruecklauf = nibe('_return_line_bt3');
    E.vorlaufSoll = nibe('_calculated_supply_climate_system_1');
    E.wwOben = nibe('_hot_water_top_bt7');
    E.wwLade = nibe('_hot_water_charging_bt6');
    E.kompressor = nibe('_requested_compressor_freq_eb101');
    E.gm = nibe('_degree_minutes');
    E.gmStart = finde(/^number\.[a-z0-9_]*_start_compressor$/);
    E.prio = nibe('_priority');
    E.abluft = nibe('_exhaust_air_az30_bt20');
    E.fortluft = nibe('_extract_air_az30_bt21');
    E.zuluft = nibe('_supply_air_az30_bt22');
    E.luefter = finde(/^sensor\.[a-z0-9_]*_fan_speed_gq2$/) || finde(/^sensor\.[a-z0-9_]*_fan_speed_gq3$/);
    E.betriebsart = finde(/^select\.[a-z0-9_]*_op_mode$/);
    E.wwBedarf = finde(/^select\.[a-z0-9_]*_hot_water_demand$/);
    E.wwExtra = finde(/^select\.[a-z0-9_]*_hot_water_boost$/);
    E.luftStufe = finde(/^select\.[a-z0-9_]*_fan_speed$/);
    E.raumSoll = finde(/^number\.[a-z0-9_]*_room_sensor_set_point_value_climate_system_1_heating$/);
    E.offset = finde(/^number\.[a-z0-9_]*_heating_offset_climate_system_1$/);
    E.zusatz = finde(/^select\.[a-z0-9_]*_set_max_electrical_add$/);
    E.wetter = finde(/^weather\./);
    E.sonne = 'sun.sun';
  }

  // Wallboxen: alles, was die Easee-Integration liefert, je Gerät gebündelt.
  function wallboxen() {
    const nachGeraet = {};
    for (const id of alle()) {
      const r = reg(id);
      if (r.platform !== 'easee' || !r.device_id) continue;
      (nachGeraet[r.device_id] = nachGeraet[r.device_id] || []).push(id);
    }
    return Object.entries(nachGeraet).map(([did, ids]) => {
      const f = re => ids.find(i => re.test(i)) || null;
      const d = hass.devices[did] || {};
      return {
        id: did, ids,
        name: geraeteName(d) || 'Wallbox',
        bereich: d.area_id && hass.areas[d.area_id] ? hass.areas[d.area_id].name : '',
        status: f(/^sensor\.[a-z0-9_]+_status$/),
        leistung: f(/^sensor\.[a-z0-9_]+_leistung$/),
        sitzung: f(/^sensor\.[a-z0-9_]+_sitzungsenergie$/),
        kostenTag: f(/_kosten_tag$/), kostenMonat: f(/_kosten_monat$/), kostenJahr: f(/_kosten_jahr$/),
        gesamt: f(/_gesamtenergie$/), strom: f(/^sensor\.[a-z0-9_]+_strom$/), spannung: f(/_spannung$/),
        phasen: f(/_phasenmodus$/), grund: f(/_grund_fur_keinen_strom$/), temp: f(/_interne_temperatur$/),
        erlaubt: f(/^switch\.[a-z0-9_]+_charger_aktiviert$/), smart: f(/^switch\.[a-z0-9_]+_smart_charging$/),
        verriegelt: f(/^switch\.[a-z0-9_]+_kabel_dauerhaft_verriegelt$/), online: f(/^binary_sensor\.[a-z0-9_]+_online$/),
        kabel: f(/^binary_sensor\.[a-z0-9_]+_kabel_verriegelt$/), licht: f(/^light\./),
        zeitplan: f(/^button\.[a-z0-9_]+_zeitplan_uberschreiben$/),
        einfZeitplan: f(/_einfacher_zeitplan$/), wochenZeitplan: f(/_wochentlicher_zeitplan$/),
        ruhestrom: f(/_ruhestrom$/), taste: f(/_taste_aktiviert$/),
      };
    }).sort((a, b) => a.name.localeCompare(b.name, 'de'));
  }

  const WB_TEXT = {
    disconnected: 'Kein Auto', awaiting_start: 'Wartet auf Start', charging: 'Lädt', completed: 'Fertig geladen',
    ready_to_charge: 'Bereit', paused: 'Pausiert', error: 'Fehler', awaiting_authorization: 'Wartet auf Freigabe',
    de_authorizing: 'Wird abgemeldet', offline: 'Offline',
  };
  const wbVerbunden = wb => { const s = st(wb.status); return !!s && !['disconnected', 'unavailable', 'unknown', 'offline'].includes(s.state); };

  // Hausgeräte: Miele, Home Connect und Shelly-Zwischenstecker.
  function hausgeraete() {
    const nach = {};
    for (const id of alle()) {
      const r = reg(id);
      if (!['miele', 'home_connect', 'shelly'].includes(r.platform) || !r.device_id) continue;
      const n = nach[r.device_id] = nach[r.device_id] || {plattform: r.platform, ids: []};
      n.ids.push(id);
    }
    const liste = [];
    for (const [did, g] of Object.entries(nach)) {
      const d = hass.devices[did] || {};
      const f = re => g.ids.find(i => re.test(i)) || null;
      const x = {id: did, plattform: g.plattform, name: geraeteName(d), ids: g.ids};
      if (g.plattform === 'miele') {
        Object.assign(x, {
          art: /trock/i.test(x.name) ? 'trockner' : /sp[uü]l/i.test(x.name) ? 'spueler' : 'waschmaschine',
          zustand: g.ids.find(i => /^sensor\.[a-z0-9_]+$/.test(i) && !/_[a-z]+_[a-z]+$/.test(i.split('.')[1].replace(/^[a-z0-9]+/, ''))) || f(/^sensor\.(waschmaschine|trockner|geschirrspuler)$/),
          rest: f(/_verbleibende_zeit$/), programm: f(/^sensor\.[a-z0-9_]+_programm$/), phase: f(/_programmphase$/),
          ende: f(/_ende$/), tuer: f(/^binary_sensor\.[a-z0-9_]+_tur$/), start: f(/^button\.[a-z0-9_]+_starten$/),
          pause: f(/^button\.[a-z0-9_]+_pausieren$/), stopp: f(/^button\.[a-z0-9_]+_stoppen$/),
          verstrichen: f(/_verstrichene_zeit$/), energie: f(/_energieverbrauch$/), problem: f(/^binary_sensor\.[a-z0-9_]+_problem$/),
        });
        if (!x.zustand) x.zustand = f(/^sensor\.[a-z]+$/);
      } else if (g.plattform === 'home_connect') {
        Object.assign(x, {
          art: /ofen/i.test(x.name) ? 'ofen' : 'spueler',
          zustand: f(/_betriebszustand$/), fortschritt: f(/_programm_fortschritt$/), programm: f(/_aktives_programm$/),
          auswahl: f(/_ausgewahltes_programm$/), tuer: f(/^sensor\.[a-z0-9_]+_tur$/), rest: f(/_verbleibende_programmzeit$|_restzeit$/),
          ende: f(/_programmende$|_endet$/), schalter: f(/^switch\.[a-z0-9_]+_einschalter$/), ofenTemp: f(/_aktuelle_ofentemperatur$|_ofentemperatur$/),
        });
      } else {
        const leist = f(/^sensor\.[a-z0-9_]+_leistung$/);
        if (!leist) continue;
        Object.assign(x, {art: 'stecker', leistung: leist, energie: f(/^sensor\.[a-z0-9_]+_energie$/), schalter: f(/^switch\./), neustart: f(/^button\.[a-z0-9_]+_neu_starten$/)});
        if (!x.name) x.name = nameVon(leist).replace(/ Leistung$/, '');
      }
      liste.push(x);
    }
    const reihenfolge = {waschmaschine: 1, trockner: 2, spueler: 3, ofen: 4, stecker: 9};
    return liste.sort((a, b) => (reihenfolge[a.art] || 5) - (reihenfolge[b.art] || 5) || a.name.localeCompare(b.name, 'de'));
  }

  const MIELE_TEXT = {
    off: 'Aus', on: 'Bereit', programmed: 'Programmiert', waiting_to_start: 'Startet später', in_use: 'Läuft',
    running: 'Läuft', pause: 'Pausiert', program_ended: 'Fertig', failure: 'Störung', program_interrupted: 'Unterbrochen',
    idle: 'Bereit', rinse_hold: 'Spülstopp', service: 'Service', superfreezing: 'Superfrost', supercooling: 'Superkühlen',
    superheating: 'Aufheizen', not_connected: 'Nicht verbunden',
  };
  const HC_TEXT = {
    inactive: 'Aus', ready: 'Bereit', delayed_start: 'Startet später', run: 'Läuft', pause: 'Pausiert',
    actionrequired: 'Bitte nachsehen', finished: 'Fertig', error: 'Störung', aborting: 'Bricht ab',
  };

  function geraetLage(g) {
    const s = st(g.zustand);
    const roh = s ? s.state : 'unavailable';
    let text = (g.plattform === 'miele' ? MIELE_TEXT[roh] : HC_TEXT[roh]) || (roh === 'unavailable' ? 'Nicht erreichbar' : roh);
    let laeuft = ['in_use', 'running', 'run', 'pause', 'delayed_start', 'waiting_to_start', 'programmed'].includes(roh);
    let fertig = ['program_ended', 'finished'].includes(roh);
    let stoerung = ['failure', 'error', 'actionrequired'].includes(roh) || (g.problem && st(g.problem) && st(g.problem).state === 'on');
    let rest = null, prozent = null;
    if (g.rest && nutzbar(g.rest)) {
      const r = st(g.rest);
      const v = parseFloat(r.state);
      if (Number.isFinite(v)) rest = (r.attributes.unit_of_measurement || 'min').startsWith('h') ? v * 60 : (r.attributes.unit_of_measurement === 's' ? v / 60 : v);
      else { const t = Date.parse(r.state); if (Number.isFinite(t)) rest = (t - Date.now()) / 60000; }
    }
    if (g.fortschritt && nutzbar(g.fortschritt)) prozent = zahl(g.fortschritt);
    else if (rest != null && g.verstrichen && nutzbar(g.verstrichen)) {
      const v = zahl(g.verstrichen); if (v != null && v + rest > 0) prozent = 100 * v / (v + rest);
    }
    if (g.art === 'stecker') {
      const w = watt(g.leistung);
      laeuft = w != null && w > 5;
      text = laeuft ? 'Läuft, ' + fw(w) : (nutzbar(g.leistung) ? 'Ruht' : 'Nicht erreichbar');
    }
    let programm = '';
    if (g.programm && nutzbar(g.programm)) {
      const p = st(g.programm).state;
      if (!/^(no_program|unknown|none)$/.test(p)) programm = uebersetze(p);
    }
    let phase = '';
    if (g.phase && nutzbar(g.phase)) { const p = st(g.phase).state; if (!/^(not_running|unknown)$/.test(p)) phase = uebersetze(p); }
    let ende = null;
    if (g.ende && nutzbar(g.ende)) { const t = Date.parse(st(g.ende).state); if (Number.isFinite(t)) ende = new Date(t); }
    if (!ende && rest != null && laeuft) ende = new Date(Date.now() + rest * 60000);
    return {text, laeuft, fertig, stoerung, rest, prozent, programm, phase, ende};
  }

  function uebersetze(t) {
    const m = {
      auto: 'Automatik', manual: 'Manuell', 'add. heat only': 'Nur Zusatzheizung', normal: 'Normal', low: 'Niedrig', high: 'Hoch',
      'smart control': 'Smart', off: 'Aus', on: 'An', 'one time increase': 'Einmalig mehr', speed_1: 'Stufe 1', speed_2: 'Stufe 2',
      speed_3: 'Stufe 3', speed_4: 'Stufe 4', 'speed 1': 'Stufe 1', 'speed 2': 'Stufe 2', 'speed 3': 'Stufe 3', 'speed 4': 'Stufe 4',
      economy: 'Sparsam', comfort: 'Komfort', luxury: 'Luxus', 'from 3 hours': '3 Stunden', '3 hours': '3 Stunden', '6 hours': '6 Stunden',
      '12 hours': '12 Stunden', 'one time': 'Einmalig', preserve_charge: 'Reserve halten', charging: 'Lädt', discharging: 'Entlädt',
      idle: 'Wartet', standby: 'Bereitschaft', producing: 'Erzeugt', sleeping: 'Ruht', throttled: 'Gedrosselt', fault: 'Störung',
      off_grid: 'Inselbetrieb', starting: 'Startet', shutting_down: 'Fährt herunter', mppt: 'Erzeugt', three: '3 Phasen', auto_phase: 'Automatisch',
      single: '1 Phase',
    };
    const k = String(t).toLowerCase();
    if (m[k]) return m[k];
    const s = String(t).replace(/_/g, ' ');
    return s.charAt(0).toUpperCase() + s.slice(1);
  }

  // ---------------------------------------------------------------- Energiemodell

  function energieJetzt() {
    const pvAc = watt(E.pvAc), pvDc = watt(E.pvDc), netz = watt(E.netz), batP = watt(E.batP), soc = zahl(E.soc);
    let pv = null;
    if (pvDc != null) pv = Math.max(0, pvDc + (batP || 0));
    else if (pvAc != null) pv = Math.max(0, pvAc + (batP || 0));
    if (pv != null && pv < 15) pv = 0;
    const haus = (pvAc != null && netz != null) ? Math.max(0, pvAc - netz) : null;
    const wbs = wallboxen();
    const autos = wbs.reduce((s, wb) => s + Math.max(0, watt(wb.leistung) || 0), 0);
    const wp = Math.max(0, watt(E.wpLeistung) || 0);
    const rest = haus != null ? Math.max(0, haus - autos - wp) : null;
    return {
      pv, haus, autos, wp, rest, soc, batP: batP || 0,
      bezug: netz != null ? Math.max(0, -netz) : null,
      einspeisung: netz != null ? Math.max(0, netz) : null,
      kap: zahl(E.batKap), wbs,
    };
  }

  // Verlauf seit Mitternacht für Diagramm und Tagessummen, höchstens alle 5 Minuten neu geladen.
  async function ladeHistorie() {
    if (Date.now() - historieZeit < 5 * 60 * 1000) return;
    historieZeit = Date.now();
    const ids = [E.pvAc, E.pvDc, E.netz, E.batP, E.soc].filter(Boolean);
    if (!ids.length) return;
    const start = new Date(); start.setHours(0, 0, 0, 0);
    try {
      const r = await hass.callWS({type: 'history/history_during_period', start_time: start.toISOString(), end_time: new Date().toISOString(),
        entity_ids: ids, minimal_response: true, no_attributes: true, significant_changes_only: false});
      historie = auswerten(r, start.getTime());
      letztesHtml = '';
      zeichne();
    } catch (e) { console.warn('Verlauf', e); }
  }

  function auswerten(r, startMs) {
    const schritt = 10 * 60 * 1000;
    const jetzt = Date.now();
    const n = Math.max(1, Math.ceil((jetzt - startMs) / schritt));
    // Zeitgewichteter Mittelwert je 10-Minuten-Fenster.
    const reihe = id => {
      const out = new Array(n).fill(null);
      const pts = (r[id] || []).map(p => ({t: (p.lu != null ? p.lu * 1000 : Date.parse(p.last_changed || p.last_updated)), v: parseFloat(p.s != null ? p.s : p.state)}))
        .filter(p => Number.isFinite(p.t)).sort((a, b) => a.t - b.t);
      if (!pts.length) return out;
      const u = (st(id) && (st(id).attributes.unit_of_measurement || '').toLowerCase()) === 'kw' ? 1000 : 1;
      for (let i = 0; i < n; i++) {
        const a = startMs + i * schritt, b = Math.min(jetzt, a + schritt);
        let sum = 0, dt = 0;
        for (let k = 0; k < pts.length; k++) {
          const t0 = Math.max(a, pts[k].t), t1 = Math.min(b, k + 1 < pts.length ? pts[k + 1].t : jetzt);
          if (t1 > t0 && Number.isFinite(pts[k].v)) { sum += pts[k].v * (t1 - t0); dt += t1 - t0; }
        }
        out[i] = dt ? sum / dt * u : null;
      }
      return out;
    };
    const pvAc = reihe(E.pvAc), pvDc = E.pvDc ? reihe(E.pvDc) : null, netz = reihe(E.netz), batP = E.batP ? reihe(E.batP) : null;
    const soc = E.soc ? reihe(E.soc).map(v => v == null ? null : v / 1000 * ((st(E.soc).attributes.unit_of_measurement || '').toLowerCase() === 'kw' ? 1 : 1000)) : null;
    const pv = [], haus = [];
    let ePv = 0, eHaus = 0, eBezug = 0, eEin = 0;
    for (let i = 0; i < n; i++) {
      const b = batP ? (batP[i] || 0) : 0;
      const p = pvDc && pvDc[i] != null ? Math.max(0, pvDc[i] + b) : (pvAc[i] != null ? Math.max(0, pvAc[i] + b) : null);
      const h = (pvAc[i] != null && netz[i] != null) ? Math.max(0, pvAc[i] - netz[i]) : null;
      pv.push(p); haus.push(h);
      const std = schritt / 3600000;
      if (p != null) ePv += p * std / 1000;
      if (h != null) eHaus += h * std / 1000;
      if (netz[i] != null) { if (netz[i] < 0) eBezug += -netz[i] * std / 1000; else eEin += netz[i] * std / 1000; }
    }
    return {startMs, schritt, n, pv, haus, soc, ePv, eHaus, eBezug, eEin,
      autarkie: eHaus > 0.05 ? Math.max(0, Math.min(100, 100 * (1 - eBezug / eHaus))) : null,
      eigen: ePv > 0.05 ? Math.max(0, Math.min(100, 100 * (1 - eEin / ePv))) : null};
  }

  // ---------------------------------------------------------------- Lage im Haus

  function raeume() {
    const draussen = /(auffahrt|garten|terrasse|zuhause|garage|carport|au[sß]en|hof|einfahrt)/i;
    const liste = Object.values(hass.areas || {}).filter(a => !draussen.test(a.name) && !draussen.test(a.area_id));
    return liste.map(a => {
      const ents = alle().filter(e => bereichVon(e) === a.area_id);
      const lichter = ents.filter(e => e.startsWith('light.'));
      const an = lichter.filter(e => st(e).state === 'on');
      const temp = ents.filter(e => e.startsWith('sensor.') && st(e).attributes.device_class === 'temperature' && nutzbar(e)).map(zahl).filter(v => v != null);
      const bewegung = ents.some(e => e.startsWith('binary_sensor.') && ['motion', 'occupancy', 'presence'].includes(st(e).attributes.device_class) && st(e).state === 'on');
      const ebene = a.floor_id && hass.floors && hass.floors[a.floor_id] ? hass.floors[a.floor_id].level : null;
      return {id: a.area_id, name: a.name, lichter, an, temp: temp.length ? temp.reduce((s, v) => s + v, 0) / temp.length : null, bewegung, ebene};
    }).sort((x, y) => x.name.localeCompare(y.name, 'de'));
  }

  function meldungen() {
    const m = [];
    for (const id of alle()) {
      const r = reg(id);
      if (r.platform === 'uptime_kuma' && id.endsWith('_status') && id.startsWith('sensor.')) {
        const s = st(id).state;
        if (s === 'down') m.push({art: 'bad', text: nameVon(id).replace(/ Status$/, '') + ' nicht erreichbar', id});
        else if (s === 'pending') m.push({art: 'warn', text: nameVon(id).replace(/ Status$/, '') + ' antwortet langsam', id});
      }
    }
    const updates = findeAlle(/^update\./).filter(e => st(e).state === 'on');
    if (updates.length) m.push({art: 'info', text: updates.length === 1 ? '1 Update verfügbar' : updates.length + ' Updates verfügbar', nav: 'admin', id: updates[0]});
    const offen = zahl('sensor.aliaswacht_offen');
    if (offen) m.push({art: 'warn', text: offen === 1 ? 'Aliaswacht: 1 Alias wartet auf dich' : `Aliaswacht: ${offen} Aliasse warten auf dich`, nav: 'kameras'});
    const verd = zahl('sensor.aliaswacht_verdaechtig');
    if (verd) m.push({art: 'bad', text: `Aliaswacht: ${verd} mögliches Datenleck`, nav: 'kameras'});
    for (const g of hausgeraete()) {
      if (g.art === 'stecker') continue;
      const l = geraetLage(g);
      if (l.stoerung) m.push({art: 'bad', text: g.name + ': ' + l.text, nav: 'haushalt'});
      else if (l.fertig) m.push({art: 'ok', text: g.name + ' ist fertig', nav: 'haushalt'});
    }
    const soc = zahl(E.soc);
    if (soc != null && soc < 8) m.push({art: 'warn', text: 'Hausbatterie fast leer', nav: 'energie'});
    return m;
  }

  // ---------------------------------------------------------------- Bausteine

  const chip = (art, text, attr) => `<button class="chip ${art}" ${attr || ''}><span class="p"></span>${esc(text)}</button>`;
  const wertBox = (l, z, einheit, id, extra) => `<div class="wert" ${id ? `data-mehr="${id}"` : ''} ${extra || ''}><span class="l">${esc(l)}</span><span class="z">${z}${einheit ? `<small>${einheit}</small>` : ''}</span></div>`;

  function segment(id, titel) {
    const s = st(id); if (!s) return '';
    const opts = s.attributes.options || [];
    return `<div class="feld"><div class="l">${esc(titel)}</div><div class="segment">${opts.map(o =>
      `<button class="${o === s.state ? 'an' : ''}" data-dienst='${esc(JSON.stringify(['select', 'select_option', {entity_id: id, option: o}]))}'>${esc(uebersetze(o))}</button>`).join('')}</div></div>`;
  }

  function stepper(id, titel, einheit) {
    const s = st(id); if (!s) return '';
    const v = parseFloat(s.state), a = s.attributes;
    const step = a.step || 1, min = a.min, max = a.max;
    const nk = step < 1 ? 1 : 0;
    const set = x => `data-dienst='${esc(JSON.stringify([id.split('.')[0], 'set_value', {entity_id: id, value: Math.min(max, Math.max(min, Math.round(x / step) * step))}]))}'`;
    return `<div class="feld"><div class="l">${esc(titel)}</div><div class="stepper">
      <button ${set(v - step)} ${v - step < min ? 'disabled' : ''} aria-label="weniger">−</button>
      <span class="z" data-mehr="${id}">${Number.isFinite(v) ? fz(v, nk) : KA}${einheit ? ' ' + einheit : ''}</span>
      <button ${set(v + step)} ${v + step > max ? 'disabled' : ''} aria-label="mehr">+</button></div></div>`;
  }

  function kipp(id, titel, info) {
    const s = st(id); if (!s) return '';
    const an = s.state === 'on';
    const dom = id.split('.')[0];
    return `<div class="schalter"><span class="t">${esc(titel)}${info ? `<small>${esc(info)}</small>` : ''}</span>
      <button class="kipp ${an ? 'an' : ''}" ${s.state === 'unavailable' ? 'disabled' : ''} aria-label="${esc(titel)}" data-dienst='${esc(JSON.stringify([dom, 'toggle', {entity_id: id}]))}'></button></div>`;
  }

  function ring(prozent, farbe, innen) {
    const r = 32, u = 2 * Math.PI * r, p = Math.max(0, Math.min(100, prozent || 0));
    return `<svg class="ring" viewBox="0 0 76 76"><circle cx="38" cy="38" r="${r}" fill="none" stroke="var(--card2)" stroke-width="8"/>
      <circle cx="38" cy="38" r="${r}" fill="none" stroke="${farbe}" stroke-width="8" stroke-linecap="round" stroke-dasharray="${u * p / 100} ${u}" transform="rotate(-90 38 38)"/>
      <text x="38" y="43" text-anchor="middle" font-size="15" font-weight="650" fill="var(--text)">${innen}</text></svg>`;
  }

  const fluss = (d, w, farbe, rueck, dicke) => {
    const aktiv = w != null && w > 20;
    const dauerS = aktiv ? Math.max(0.35, 2.4 - Math.log10(w) * 0.55) : 0;
    const breite = dicke || (aktiv ? Math.min(7, 2.5 + w / 1500) : 3);
    return `<path d="${d}" stroke="${farbe}" stroke-width="${breite.toFixed(1)}" class="fluss ${aktiv ? '' : 'aus'} ${rueck ? 'rueck' : ''}" style="animation-duration:${dauerS.toFixed(2)}s"/>`;
  };

  // ---------------------------------------------------------------- Seite: Zuhause

  function himmel() {
    const s = st(E.sonne);
    const hoehe = s ? (s.attributes.elevation || 0) : 30;
    const azimut = s ? (s.attributes.azimuth || 180) : 180;
    const tag = hoehe > 0;
    const daemmerung = hoehe > -6 && hoehe < 6;
    const oben = tag ? (daemmerung ? '#f6b26b' : '#8ec9f5') : (daemmerung ? '#3c3b6e' : '#0d1b3a');
    const unten = tag ? (daemmerung ? '#fde2c4' : '#e6f4ff') : (daemmerung ? '#b46a6a' : '#26365e');
    return {tag, hoehe, azimut, oben, unten, daemmerung};
  }

  function seiteHaus() {
    const en = energieJetzt();
    const h = himmel();
    const rs = raeume();
    const wbs = en.wbs;
    const w = st(E.wetter);
    const aussen = E.aussen ? zahl(E.aussen) : (w ? w.attributes.temperature : null);
    const jetzt = new Date();
    const stunde = jetzt.getHours();
    const gruss = stunde < 5 ? 'Gute Nacht' : stunde < 11 ? 'Guten Morgen' : stunde < 17 ? 'Hallo' : stunde < 22 ? 'Guten Abend' : 'Gute Nacht';
    const kompHz = zahl(E.kompressor) || 0;

    // Räume auf zwei Ebenen verteilen, Ebene aus HA oder aus dem Namen erraten.
    const og = [], eg = [];
    for (const r of rs) {
      if (r.ebene != null) (r.ebene > 0 ? og : eg).push(r);
      else (/(schlaf|kind|bad|ankleide|gast|dach|ober)/i.test(r.name) ? og : eg).push(r);
    }
    while (og.length > 4 && eg.length < 4) eg.push(og.pop());
    while (eg.length > 4 && og.length < 4) og.push(eg.shift());

    const wand = h.tag ? '#f4efe6' : '#3b404c';
    const dach = h.tag ? '#a7503d' : '#5b3029';
    const boden = h.tag ? '#8cc56b' : '#2c4a2b';
    const fensterAus = h.tag ? '#cfe0ef' : '#1b2741';
    const textHell = h.tag ? '#1c2430' : '#e8ebf0';

    const fenster = (liste, y, hoehe) => {
      const n = liste.length; if (!n) return '';
      const links = 318, rechts = 702, mitteL = 488, mitteR = 532;
      // Links und rechts der Treppe verteilen.
      const li = liste.slice(0, Math.ceil(n / 2)), re = liste.slice(Math.ceil(n / 2));
      const block = (arr, x0, x1) => {
        if (!arr.length) return '';
        const gap = 10, bw = (x1 - x0 - gap * (arr.length - 1)) / arr.length;
        return arr.map((r, i) => {
          const x = x0 + i * (bw + gap);
          const an = r.an.length > 0;
          const t = r.temp != null ? fz(r.temp, 1) + '°' : '';
          return `<g class="klick raum" data-nav="licht" data-anker="${esc(r.id)}">
            <rect x="${x}" y="${y}" width="${bw}" height="${hoehe}" rx="8" fill="${an ? 'url(#licht)' : fensterAus}" ${an ? 'filter="url(#schein)"' : ''} stroke="${h.tag ? '#b9c6d3' : '#0b1222'}" stroke-width="2"/>
            <line x1="${x + bw / 2}" y1="${y + 4}" x2="${x + bw / 2}" y2="${y + hoehe - 30}" stroke="${an ? '#f0b94a' : (h.tag ? '#b9c6d3' : '#0b1222')}" stroke-width="2"/>
            ${r.bewegung ? `<circle cx="${x + bw - 12}" cy="${y + 12}" r="5" fill="#2f6fde" class="puls"/>` : ''}
            <rect x="${x + 4}" y="${y + hoehe - 28}" width="${bw - 8}" height="24" rx="6" fill="${h.tag ? 'rgba(255,255,255,.82)' : 'rgba(10,16,30,.7)'}"/>
            <text x="${x + bw / 2}" y="${y + hoehe - 11}" text-anchor="middle" font-size="${bw < 80 ? 10.5 : 12}" font-weight="600" fill="${textHell}">${esc(kurz(r.name, bw))}</text>
            ${t ? `<text x="${x + 8}" y="${y + 18}" font-size="12" font-weight="600" fill="${an ? '#6b4a00' : textHell}">${t}</text>` : ''}
          </g>`;
        }).join('');
      };
      return block(li, links, mitteL) + block(re, mitteR, rechts);
    };

    // Sonne oder Mond
    let himmelskoerper = '';
    if (h.tag) {
      const x = 60 + Math.max(0, Math.min(1, (h.azimut - 70) / 220)) * 880;
      const y = 200 - Math.max(0, Math.min(60, h.hoehe)) / 60 * 160;
      himmelskoerper = `<circle cx="${x}" cy="${y}" r="26" fill="#ffd34d"/><circle cx="${x}" cy="${y}" r="40" fill="#ffd34d" opacity=".25"/>`;
    } else {
      himmelskoerper = `<circle cx="860" cy="70" r="20" fill="#f1f1e6"/><circle cx="870" cy="64" r="18" fill="${h.oben}"/>` +
        [[120, 40], [220, 90], [330, 30], [610, 60], [700, 25], [760, 120], [940, 150], [80, 160], [470, 45]].map(([x, y], i) =>
          `<circle cx="${x}" cy="${y}" r="${i % 3 ? 1.4 : 2}" fill="#fff" class="${i % 2 ? 'puls' : ''}" style="animation-duration:${2 + i % 3}s"/>`).join('');
    }

    // PV-Module auf der Dachfläche
    const pvAnteil = en.pv != null ? Math.min(1, en.pv / 4000) : 0;
    const reihen = [[122, 26], [152, 28], [184, 30]];
    const module = reihen.map(([y, hh]) => {
      const f = (yy) => 280 + (232 - yy) / 122 * 70; // linke Dachkante
      const xa = f(y) + 18, xe = 1020 - f(y) - 18;
      const n = 8, gap = 4, bw = (xe - xa - gap * (n - 1)) / n;
      return Array.from({length: n}, (_, i) => `<rect x="${xa + i * (bw + gap)}" y="${y}" width="${bw}" height="${hh}" rx="2" fill="#1d3557" stroke="#8fb3d9" stroke-width="1"/>`).join('');
    }).join('');

    // Autos und Wallboxen
    const autoSvg = (x, farbe) => `<g transform="translate(${x},458)">
      <path d="M6 40 Q4 24 18 20 L34 6 Q38 2 46 2 L78 2 Q86 2 92 10 L104 22 Q116 24 116 36 L116 42 Q116 46 112 46 L8 46 Q4 46 6 40Z" fill="${farbe}"/>
      <path d="M38 8 L48 8 L48 20 L28 20Z M54 8 L76 8 Q82 8 86 14 L92 20 L54 20Z" fill="${h.tag ? '#dff1ff' : '#22304f'}"/>
      <circle cx="28" cy="46" r="10" fill="#1f2328"/><circle cx="28" cy="46" r="4" fill="#9aa4b2"/>
      <circle cx="94" cy="46" r="10" fill="#1f2328"/><circle cx="94" cy="46" r="4" fill="#9aa4b2"/></g>`;
    const wbX = [770, 880];
    const autos = wbs.slice(0, 2).map((wb, i) => {
      const x = wbX[i];
      const s = st(wb.status);
      const verbunden = wbVerbunden(wb);
      const p = watt(wb.leistung) || 0;
      const laedt = p > 50;
      const lichtAn = wb.licht && st(wb.licht) && st(wb.licht).state === 'on';
      const label = laedt ? 'lädt ' + fw(p) : (s ? (WB_TEXT[s.state] || uebersetze(s.state)) : KA);
      return `<g class="klick" data-nav="wallboxen">
        <rect x="${x}" y="440" width="16" height="78" rx="4" fill="${h.tag ? '#2b2f36' : '#11151b'}"/>
        <rect x="${x + 3}" y="446" width="10" height="16" rx="3" fill="${lichtAn ? (laedt ? '#00d2ff' : '#7ee787') : '#4a515c'}" ${laedt ? 'class="puls"' : ''}/>
        ${verbunden ? autoSvg(x + 22, i ? '#c0392b' : '#3a6ea5') + `<path d="M${x + 13} 470 Q${x + 22} 500 ${x + 30} 486" stroke="#111" stroke-width="3" fill="none"/>` :
          `<rect x="${x + 24}" y="470" width="80" height="44" rx="10" fill="none" stroke="${h.tag ? '#6b7a5c' : '#546150'}" stroke-dasharray="6 6" stroke-width="2"/>`}
        ${laedt ? `<path d="M${x + 76} 472 l-8 14 h8 l-6 14 l16 -18 h-8 l6 -10z" fill="#ffe14d" class="puls"/>` : ''}
        <rect x="${x - 4}" y="412" width="${Math.max(96, label.length * 7 + 16)}" height="22" rx="11" fill="${h.tag ? 'rgba(255,255,255,.85)' : 'rgba(10,16,30,.72)'}"/>
        <text x="${x + 4}" y="427" font-size="12" font-weight="600" fill="${textHell}">${esc(kurz(wb.name, 60))}: ${esc(label)}</text>
      </g>`;
    }).join('');

    const pill = (x, y, text, farbe, anker) => {
      const breite = text.length * 7.2 + 22;
      const x0 = anker === 'end' ? x - breite : anker === 'middle' ? x - breite / 2 : x;
      return `<rect x="${x0}" y="${y - 15}" width="${breite}" height="24" rx="12" fill="${h.tag ? 'rgba(255,255,255,.9)' : 'rgba(10,16,30,.75)'}" stroke="${farbe}" stroke-width="1.5"/>
        <text x="${x0 + breite / 2}" y="${y + 1}" text-anchor="middle" font-size="12.5" font-weight="650" fill="${textHell}">${esc(text)}</text>`;
    };

    const batFill = Math.max(0, Math.min(100, en.soc || 0));
    const batTxt = en.batP > 50 ? 'lädt ' + fw(en.batP) : en.batP < -50 ? 'gibt ' + fw(-en.batP) : 'ruht';
    const netzTxt = en.bezug > 20 ? 'Bezug ' + fw(en.bezug) : en.einspeisung > 20 ? 'Einspeisung ' + fw(en.einspeisung) : 'Netz ruhig';

    const szene = `<svg class="szene" viewBox="0 0 1000 610" role="img" aria-label="Haus mit Energiefluss">
      <defs>
        <linearGradient id="himmel" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${h.oben}"/><stop offset="1" stop-color="${h.unten}"/></linearGradient>
        <radialGradient id="licht" cx=".5" cy=".35" r=".8"><stop offset="0" stop-color="#fff3c4"/><stop offset=".6" stop-color="#ffd36b"/><stop offset="1" stop-color="#f3b13b"/></radialGradient>
        <filter id="schein" x="-40%" y="-40%" width="180%" height="180%"><feGaussianBlur stdDeviation="6" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
        <linearGradient id="batt" x1="0" y1="1" x2="0" y2="0"><stop offset="0" stop-color="#1f9d55"/><stop offset="1" stop-color="#5dd39e"/></linearGradient>
        <clipPath id="battClip"><rect x="232" y="${400 + 106 * (1 - batFill / 100)}" width="52" height="${106 * batFill / 100}"/></clipPath>
      </defs>
      <rect width="1000" height="610" fill="url(#himmel)"/>
      ${himmelskoerper}
      <rect y="518" width="1000" height="92" fill="${boden}"/>
      <rect y="518" width="1000" height="6" fill="${h.tag ? '#79b05a' : '#243f24'}"/>

      <!-- Netzmast -->
      <g class="klick" data-mehr="${E.netz || ''}">
        <path d="M60 518 L70 330 L80 518Z" fill="none" stroke="${h.tag ? '#5b6573' : '#8892a0'}" stroke-width="4"/>
        <path d="M46 350 H94 M52 380 H88" stroke="${h.tag ? '#5b6573' : '#8892a0'}" stroke-width="4"/>
        ${pill(70, 312, netzTxt, '#7b61ff', 'middle')}
      </g>

      <!-- Außeneinheit Wärmepumpe -->
      <g class="klick" data-nav="heizung">
        <rect x="112" y="452" width="104" height="66" rx="8" fill="${h.tag ? '#e9edf2' : '#59606d'}" stroke="${h.tag ? '#aab4c0' : '#2c313a'}" stroke-width="2"/>
        <circle cx="146" cy="485" r="24" fill="${h.tag ? '#cfd6df' : '#3d434e'}"/>
        <g class="${kompHz > 0 ? 'dreh' : ''}" style="animation-duration:${kompHz > 0 ? Math.max(0.25, 2.2 - kompHz / 50).toFixed(2) : 0}s">
          <path d="M146 485 L146 464 Q156 470 146 485 M146 485 L166 492 Q158 500 146 485 M146 485 L128 497 Q126 486 146 485" fill="${h.tag ? '#7c8796' : '#a5aebb'}"/>
        </g>
        <rect x="180" y="466" width="28" height="6" rx="3" fill="${kompHz > 0 ? '#e8590c' : '#9aa4b2'}"/>
        ${pill(164, 438, en.wp > 30 ? 'Wärmepumpe ' + fw(en.wp) : 'Wärmepumpe ruht', '#e8590c', 'middle')}
      </g>

      <!-- Hausbatterie -->
      <g class="klick" data-nav="energie">
        <rect x="226" y="392" width="64" height="122" rx="10" fill="${h.tag ? '#2b2f36' : '#11151b'}"/>
        <rect x="244" y="384" width="28" height="10" rx="3" fill="${h.tag ? '#2b2f36' : '#11151b'}"/>
        <rect x="232" y="400" width="52" height="106" rx="6" fill="${h.tag ? '#41474f' : '#262b33'}"/>
        <rect x="232" y="400" width="52" height="106" rx="6" fill="url(#batt)" clip-path="url(#battClip)"/>
        <text x="258" y="460" text-anchor="middle" font-size="16" font-weight="700" fill="#fff">${en.soc != null ? Math.round(en.soc) + '%' : KA}</text>
        ${en.batP > 50 ? `<path d="M258 470 l-7 12 h6 l-4 11 l12 -15 h-6 l4 -8z" fill="#fff" class="puls"/>` : ''}
      </g>

      <!-- Haus -->
      <rect x="300" y="228" width="420" height="292" fill="${wand}" stroke="${h.tag ? '#cfc6b8' : '#232730'}" stroke-width="2"/>
      <path d="M278 234 L350 108 L670 108 L742 234 Z" fill="${dach}"/>
      <g class="klick" data-nav="energie">${module}
        <path d="M296 220 L356 116 L664 116 L724 220Z" fill="#ffe680" opacity="${(pvAnteil * 0.55).toFixed(2)}" pointer-events="none"/>
      </g>
      ${pill(510, 96, en.pv > 0 ? 'Sonne ' + fw(en.pv) : 'PV ruht', '#f5a623', 'middle')}
      <rect x="490" y="236" width="40" height="282" fill="${h.tag ? '#e7e0d3' : '#333844'}"/>
      ${fenster(og, 246, 112)}
      ${fenster(eg, 384, 120)}

      <!-- Energiefluss im Boden -->
      ${fluss('M510 224 L510 528', en.pv, '#f5a623')}
      ${fluss('M70 518 L70 556 L478 556', en.bezug > 20 ? en.bezug : en.einspeisung, '#7b61ff', en.einspeisung > 20 && !(en.bezug > 20))}
      ${fluss('M258 514 L258 540 L482 540', Math.abs(en.batP), '#1f9d55', en.batP < -50)}
      ${fluss('M164 518 L164 576 L488 576', en.wp, '#e8590c', true)}
      ${wbs[0] ? fluss('M778 518 L778 556 L542 556', watt(wbs[0].leistung) || 0, '#00a2c7', true) : ''}
      ${wbs[1] ? fluss('M888 518 L888 576 L534 576', watt(wbs[1].leistung) || 0, '#00a2c7', true) : ''}
      <g class="klick" data-nav="energie">
        <circle cx="510" cy="558" r="34" fill="${h.tag ? '#ffffff' : '#1c1f26'}" stroke="#2f6fde" stroke-width="3"/>
        <text x="510" y="552" text-anchor="middle" font-size="10.5" fill="${h.tag ? '#667085' : '#98a2b3'}">Haus</text>
        <text x="510" y="569" text-anchor="middle" font-size="14" font-weight="700" fill="${textHell}">${en.haus != null ? fw(en.haus) : KA}</text>
      </g>
      ${autos}
    </svg>`;

    const ms = meldungen();
    const laufend = hausgeraete().filter(g => g.art !== 'stecker').map(g => ({g, l: geraetLage(g)})).filter(x => x.l.laeuft);
    const lichterAn = findeAlle(/^light\./).filter(e => st(e).state === 'on');
    const ww = zahl(E.wwOben), raumT = zahl(E.raum);
    const pers = findeAlle(/^person\./);

    const kacheln = [
      {nav: 'energie', farbe: 'var(--sun)', titel: 'Energie', zeile: en.pv > 0 ? `Sonne ${fw(en.pv)}, Haus ${fw(en.haus)}` : `Haus ${fw(en.haus)}`, zeile2: `Batterie ${en.soc != null ? Math.round(en.soc) + ' %' : KA}`},
      {nav: 'heizung', farbe: 'var(--heat)', titel: 'Wärme & Luft', zeile: `Innen ${ft(raumT)}`, zeile2: `Warmwasser ${ft(ww)}`},
      {nav: 'wallboxen', farbe: 'var(--car)', titel: 'Mobilität', zeile: wbs.map(wb => `${kurz(wb.name, 70)}: ${(watt(wb.leistung) || 0) > 50 ? 'lädt' : (WB_TEXT[(st(wb.status) || {}).state] || 'k. A.')}`).join(', ') || 'Keine Wallbox', zeile2: ''},
      {nav: 'haushalt', farbe: '#9b5de5', titel: 'Haushalt', zeile: laufend.length ? laufend.map(x => x.g.name).join(', ') + ' läuft' : 'Alles ruht', zeile2: ''},
      {nav: 'licht', farbe: 'var(--glow)', titel: 'Räume & Licht', zeile: lichterAn.length ? `${lichterAn.length} Licht${lichterAn.length === 1 ? '' : 'er'} an` : 'Alle Lichter aus', zeile2: ''},
      {nav: 'netzwerk', farbe: 'var(--accent)', titel: 'Netzwerk', zeile: 'Datenwege und Geräte', zeile2: ''},
      {nav: 'server', farbe: '#475467', titel: 'Server & NAS', zeile: serverZeile(), zeile2: ''},
      {nav: 'kameras', farbe: 'var(--bad)', titel: 'Sicherheit', zeile: aliasZeile(), zeile2: 'Kameras und Aliaswacht'},
    ];

    return `
      <div class="kopf">
        <div><h1>${gruss}</h1><div class="unter">${jetzt.toLocaleDateString('de-DE', {weekday: 'long', day: 'numeric', month: 'long'})}${pers.length ? ' · ' + pers.map(p => esc(nameVon(p).split(' ')[0]) + (st(p).state === 'home' ? ' zu Hause' : ' unterwegs')).join(', ') : ''}</div></div>
        <div class="wetter" ${E.wetter ? `data-mehr="${E.wetter}"` : ''} style="cursor:pointer"><b>${aussen != null ? fz(aussen, 1) + '°' : ''}</b><span>${w ? esc(wetterText(w.state)) : ''}<br>draußen</span></div>
      </div>
      <div class="karte" style="padding:0;overflow:hidden">${szene}</div>
      <div class="abstand"></div>
      <div class="raster">
        <div class="karte"><h2>Jetzt wichtig</h2><div class="chips">${ms.length ? ms.map(m => chip(m.art, m.text, m.nav ? `data-nav="${m.nav}"` : (m.id ? `data-mehr="${m.id}"` : ''))).join('') : chip('ok', 'Alles in Ordnung', 'data-nav="server"')}
          ${laufend.map(x => chip('info', x.g.name + (x.l.rest != null ? ' noch ' + dauer(x.l.rest) : ' läuft'), 'data-nav="haushalt"')).join('')}</div></div>
        <div class="karte"><h2>Schnell erledigt</h2><div class="knoepfe">
          <button class="knopf" data-dienst='${esc(JSON.stringify(['light', 'turn_off', {entity_id: findeAlle(/^light\./).filter(e => !wbs.some(wb => wb.licht === e))}]))}' ${lichterAn.length ? '' : 'disabled'}>Alle Lichter aus</button>
          ${E.wwExtra ? `<button class="knopf ${st(E.wwExtra).state !== 'Off' ? 'an' : ''}" data-dienst='${esc(JSON.stringify(['select', 'select_option', {entity_id: E.wwExtra, option: (st(E.wwExtra).attributes.options || []).find(o => o !== 'Off') || 'Off'}]))}'>Warmwasser extra</button>` : ''}
          ${wbs.filter(wb => wb.licht).length ? `<button class="knopf" data-dienst='${esc(JSON.stringify(['light', 'toggle', {entity_id: wbs.filter(wb => wb.licht).map(wb => wb.licht)}]))}'>Wallbox-Licht umschalten</button>` : ''}
          <button class="knopf" data-nav="licht">Licht &amp; Szenen</button>
        </div></div>
      </div>
      <div class="abstand"></div>
      <div class="raster klein">${kacheln.map(k => `<div class="karte klick" data-nav="${k.nav}" style="cursor:pointer;border-top:4px solid ${k.farbe}">
        <h2>${esc(k.titel)}</h2><div>${esc(k.zeile)}</div>${k.zeile2 ? `<div class="hinweis">${esc(k.zeile2)}</div>` : ''}</div>`).join('')}</div>`;
  }

  function kurz(t, breite) {
    const max = Math.max(6, Math.floor(breite / 7));
    t = String(t).replace(/^Kinderzimmer /, 'Kind. ');
    return t.length > max ? t.slice(0, max - 1) + '…' : t;
  }
  function wetterText(s) {
    return ({'clear-night': 'Klare Nacht', cloudy: 'Bewölkt', exceptional: 'Unwetter', fog: 'Nebel', hail: 'Hagel', lightning: 'Gewitter',
      'lightning-rainy': 'Gewitter', partlycloudy: 'Teils bewölkt', pouring: 'Starkregen', rainy: 'Regen', snowy: 'Schnee',
      'snowy-rainy': 'Schneeregen', sunny: 'Sonnig', windy: 'Windig', 'windy-variant': 'Windig'})[s] || s;
  }
  function serverZeile() {
    const cpu = finde(/^sensor\.[a-z0-9_]+_cpu_auslastung_gesamt$/), vol = finde(/^sensor\.[a-z0-9_]+_volume_1_volume_nutzung$/);
    const teile = [];
    if (cpu) teile.push('CPU ' + Math.round(zahl(cpu) || 0) + ' %');
    if (vol) teile.push('Speicher ' + Math.round(zahl(vol) || 0) + ' % belegt');
    return teile.join(', ') || 'Status ansehen';
  }
  function aliasZeile() {
    if (!st('sensor.aliaswacht_offen')) return 'Kameras ansehen';
    const o = zahl('sensor.aliaswacht_offen') || 0;
    return o ? `${o} Alias${o === 1 ? '' : 'se'} offen` : 'Alle Aliasse entschieden';
  }

  // ---------------------------------------------------------------- Seite: Energie

  function seiteEnergie() {
    ladeHistorie();
    const en = energieJetzt();
    const hi = historie;
    const knoten = (x, y, r, farbe, emoji, titel, wert, ziel) => `<g class="klick" ${ziel}>
      <circle cx="${x}" cy="${y}" r="${r}" fill="var(--card)" stroke="${farbe}" stroke-width="4"/>
      <text x="${x}" y="${y - 6}" text-anchor="middle" font-size="22">${emoji}</text>
      <text x="${x}" y="${y + 16}" text-anchor="middle" font-size="13" font-weight="700" fill="var(--text)">${esc(wert)}</text>
      <text x="${x}" y="${y + r + 18}" text-anchor="middle" font-size="12.5" fill="var(--muted)">${esc(titel)}</text></g>`;
    const H = {x: 330, y: 190};
    const flussSvg = `<svg class="szene" viewBox="0 0 660 400">
      ${fluss(`M120 80 Q ${H.x - 80} 90 ${H.x - 52} ${H.y - 30}`, en.pv, 'var(--sun)')}
      ${fluss(`M120 300 Q ${H.x - 80} 290 ${H.x - 52} ${H.y + 30}`, Math.abs(en.batP), 'var(--bat)', en.batP > 50)}
      ${fluss(`M100 190 L ${H.x - 58} ${H.y}`, en.bezug > 20 ? en.bezug : en.einspeisung, 'var(--grid)', en.einspeisung > 20 && !(en.bezug > 20))}
      ${fluss(`M${H.x + 52} ${H.y - 30} Q ${H.x + 80} 90 540 80`, en.rest, 'var(--accent)')}
      ${fluss(`M${H.x + 58} ${H.y} L 560 190`, en.wp, 'var(--heat)')}
      ${fluss(`M${H.x + 52} ${H.y + 30} Q ${H.x + 80} 290 540 300`, en.autos, 'var(--car)')}
      ${fluss(`M150 70 Q 330 0 510 290`, 0, 'transparent')}
      ${knoten(90, 75, 42, 'var(--sun)', '☀️', 'Sonne', fw(en.pv), `data-mehr="${E.pvAc || ''}"`)}
      ${knoten(70, 190, 42, 'var(--grid)', '🔌', en.bezug > 20 ? 'Netzbezug' : en.einspeisung > 20 ? 'Einspeisung' : 'Netz', fw(en.bezug > 20 ? en.bezug : en.einspeisung || 0), `data-mehr="${E.netz || ''}"`)}
      ${knoten(90, 305, 42, 'var(--bat)', '🔋', 'Batterie ' + (en.soc != null ? Math.round(en.soc) + ' %' : ''), en.batP > 50 ? '+' + fw(en.batP) : en.batP < -50 ? '−' + fw(-en.batP) : 'ruht', `data-mehr="${E.soc || ''}"`)}
      <g class="klick" data-nav="licht"><circle cx="${H.x}" cy="${H.y}" r="62" fill="var(--card)" stroke="var(--accent)" stroke-width="5"/>
        <text x="${H.x}" y="${H.y - 14}" text-anchor="middle" font-size="28">🏠</text>
        <text x="${H.x}" y="${H.y + 16}" text-anchor="middle" font-size="19" font-weight="700" fill="var(--text)">${fw(en.haus)}</text>
        <text x="${H.x}" y="${H.y + 34}" text-anchor="middle" font-size="12" fill="var(--muted)">Verbrauch gesamt</text></g>
      ${knoten(570, 75, 42, 'var(--accent)', '💡', 'Haushalt', fw(en.rest), 'data-nav="haushalt"')}
      ${knoten(595, 190, 42, 'var(--heat)', '♨️', 'Wärmepumpe', fw(en.wp), 'data-nav="heizung"')}
      ${knoten(570, 305, 42, 'var(--car)', '🚗', 'Autos', fw(en.autos), 'data-nav="wallboxen"')}
    </svg>`;

    // Batterie groß
    const soc = en.soc;
    const kap = en.kap;
    const gespeichert = soc != null && kap ? kap * soc / 100 : null;
    let zeitText = '';
    if (en.batP > 50 && kap && soc != null) zeitText = 'voll in etwa ' + dauer((kap * (100 - soc) / 100) / (en.batP / 1000) * 60);
    else if (en.batP < -50 && kap && soc != null) {
      const reserve = zahl(E.reserve) || 0;
      zeitText = 'reicht noch etwa ' + dauer((kap * Math.max(0, soc - reserve) / 100) / (-en.batP / 1000) * 60);
    }
    const zellen = 10, gefuellt = soc != null ? Math.round(soc / 10) : 0;
    const batterie = `<svg viewBox="0 0 320 120" style="width:100%;max-width:420px;display:block;margin:4px auto 10px">
      <rect x="4" y="10" width="290" height="100" rx="16" fill="none" stroke="var(--text)" stroke-width="4"/>
      <rect x="296" y="40" width="16" height="40" rx="5" fill="var(--text)"/>
      ${Array.from({length: zellen}, (_, i) => `<rect x="${14 + i * 28}" y="20" width="22" height="80" rx="5" fill="${i < gefuellt ? (soc < 15 ? 'var(--bad)' : soc < 35 ? 'var(--warn)' : 'var(--bat)') : 'var(--card2)'}" ${i === gefuellt - 1 && en.batP > 50 ? 'class="puls"' : ''}/>`).join('')}
    </svg>`;
    const bs = st(E.batStatus);

    // Tagesdiagramm
    let diagramm = '<p class="hinweis">Verlauf wird geladen …</p>';
    if (hi && hi.n > 1) {
      const W = 720, Hh = 190, l = 36, r = 30, o = 10, u = 22;
      const maxW = Math.max(500, ...hi.pv.filter(v => v != null), ...hi.haus.filter(v => v != null)) * 1.1;
      const n = Math.max(hi.n, 144);
      const x = i => l + (W - l - r) * i / (n - 1);
      const y = v => o + (Hh - o - u) * (1 - v / maxW);
      const ys = v => o + (Hh - o - u) * (1 - v / 100);
      const pfad = (arr, fn) => arr.map((v, i) => v == null ? null : [x(i), fn(v)]).filter(Boolean).map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(' ');
      const pvPfad = pfad(hi.pv, y);
      const flaeche = pvPfad ? pvPfad + ` L${x(hi.pv.length - 1).toFixed(1)} ${y(0)} L${x(hi.pv.findIndex(v => v != null)).toFixed(1)} ${y(0)} Z` : '';
      const achse = [0, 6, 12, 18, 24].map(hh => `<text x="${x(hh * 6) - 8}" y="${Hh - 6}">${hh} Uhr</text>`).join('');
      const skala = [0.5, 1].map(f => `<line x1="${l}" x2="${W - r}" y1="${y(maxW * f / 1.1)}" y2="${y(maxW * f / 1.1)}" stroke="var(--line)"/><text x="2" y="${y(maxW * f / 1.1) + 4}">${fz(maxW * f / 1.1 / 1000, 1)}</text>`).join('');
      diagramm = `<svg class="diagramm" viewBox="0 0 ${W} ${Hh}" preserveAspectRatio="none">${skala}
        <path d="${flaeche}" fill="var(--sun)" opacity=".28"/><path d="${pvPfad}" fill="none" stroke="var(--sun)" stroke-width="2"/>
        <path d="${pfad(hi.haus, y)}" fill="none" stroke="var(--accent)" stroke-width="2"/>
        ${hi.soc ? `<path d="${pfad(hi.soc, ys)}" fill="none" stroke="var(--bat)" stroke-width="2" stroke-dasharray="5 4"/>` : ''}
        ${achse}</svg>
        <div class="legende"><span><i style="background:var(--sun)"></i>Sonne (kW)</span><span><i style="background:var(--accent)"></i>Verbrauch (kW)</span><span><i style="background:var(--bat)"></i>Batterie (%)</span></div>`;
    }

    return `
      <div class="kopf"><div><h1>Energie</h1><div class="unter">${en.pv > 0 && en.haus != null ? (en.pv >= en.haus ? 'Die Sonne deckt gerade den ganzen Verbrauch.' : `Die Sonne deckt gerade ${Math.round(100 * en.pv / Math.max(1, en.haus))} % des Verbrauchs.`) : 'Gerade keine Sonnenenergie.'}</div></div>
        ${hi && hi.autarkie != null ? `<div class="wetter"><b>${Math.round(hi.autarkie)} %</b><span>selbst versorgt<br>heute</span></div>` : ''}</div>
      <div class="raster" style="grid-template-columns:repeat(auto-fit,minmax(320px,1fr))">
        <div class="karte"><h2>Energiefluss jetzt</h2>${flussSvg}</div>
        <div class="karte"><h2>Hausbatterie<span class="mehr" data-mehr="${E.soc || ''}">Verlauf</span></h2>${batterie}
          <div class="werte">
            ${wertBox('Ladestand', soc != null ? Math.round(soc) : KA, '%', E.soc)}
            ${wertBox('Gespeichert', gespeichert != null ? fz(gespeichert, 1) : KA, 'kWh', E.batKap)}
            ${wertBox('Leistung', en.batP > 50 ? '+' + fw(en.batP) : en.batP < -50 ? '−' + fw(-en.batP) : '0 W', '', E.batP)}
            ${wertBox('Zustand', bs ? esc(uebersetze(bs.state)) : KA, '', E.batStatus)}
            ${E.reserve ? wertBox('Notstrom-Reserve', fz(zahl(E.reserve), 0), '%', E.reserve) : ''}
            ${E.batSoh ? wertBox('Gesundheit', fz(zahl(E.batSoh), 0), '%', E.batSoh) : ''}
            ${E.batTemp ? wertBox('Temperatur', fz(zahl(E.batTemp), 1), '°C', E.batTemp) : ''}
          </div>${zeitText ? `<p class="hinweis" style="margin:10px 2px 0">${esc(zeitText)}</p>` : ''}</div>
      </div>
      <div class="abstand"></div>
      <div class="raster" style="grid-template-columns:repeat(auto-fit,minmax(320px,1fr))">
        <div class="karte"><h2>Heute</h2>${diagramm}</div>
        <div class="karte"><h2>Tagesbilanz</h2><div class="werte">
          ${wertBox('Sonne erzeugt', hi ? fz(hi.ePv, 1) : KA, 'kWh')}
          ${wertBox('Haus verbraucht', hi ? fz(hi.eHaus, 1) : KA, 'kWh')}
          ${wertBox('Aus dem Netz', hi ? fz(hi.eBezug, 1) : KA, 'kWh')}
          ${wertBox('Eingespeist', hi ? fz(hi.eEin, 1) : KA, 'kWh')}
          ${wertBox('Selbst versorgt', hi && hi.autarkie != null ? Math.round(hi.autarkie) : KA, '%')}
          ${wertBox('Sonnenstrom selbst genutzt', hi && hi.eigen != null ? Math.round(hi.eigen) : KA, '%')}
        </div><p class="hinweis" style="margin:10px 2px 0">Wechselrichter: ${esc(st(E.wr) ? uebersetze(st(E.wr).state) : KA)}${E.wrTemp ? ', ' + ft(zahl(E.wrTemp)) : ''}. Werte ab Mitternacht, alle 5 Minuten neu berechnet.</p></div>
      </div>`;
  }

  // ---------------------------------------------------------------- Seite: Wärme & Luft

  function seiteWaerme() {
    const t = id => zahl(id);
    const aussen = t(E.aussen), raum = t(E.raum), vl = t(E.vorlauf), rl = t(E.ruecklauf), wwO = t(E.wwOben), wwL = t(E.wwLade);
    const hz = t(E.kompressor) || 0, gm = t(E.gm), gmStart = t(E.gmStart);
    const ab = t(E.abluft), fort = t(E.fortluft), zu = t(E.zuluft), luef = t(E.luefter);
    const prio = t(E.prio);
    const prioText = prio === 20 ? 'macht Warmwasser' : prio === 30 ? 'heizt' : prio === 40 ? 'heizt Pool' : prio === 60 ? 'kühlt' : hz > 0 ? 'läuft' : 'ruht';
    const farbe = v => { if (v == null) return '#9aa4b2'; const f = Math.max(0, Math.min(1, (v - 20) / 35)); return `hsl(${Math.round(215 - f * 205)} 80% ${50 - f * 4}%)`; };
    const wwFill = wwO != null ? Math.max(0.1, Math.min(1, (wwO - 25) / 30)) : 0.3;
    const luftDauer = luef ? Math.max(0.3, 2.5 - luef / 45) : 0;

    const svg = `<svg class="szene" viewBox="0 0 1000 420" role="img" aria-label="Heizung und Lüftung">
      <defs>
        <linearGradient id="wwGrad" x1="0" y1="1" x2="0" y2="0"><stop offset="0" stop-color="${farbe(wwL != null ? wwL - 8 : 30)}"/><stop offset="1" stop-color="${farbe(wwO)}"/></linearGradient>
      </defs>
      <rect width="1000" height="420" rx="16" fill="var(--card)"/>
      <rect x="0" y="0" width="200" height="420" fill="${aussen != null && aussen < 3 ? '#e3eefc' : '#eaf6ea'}" opacity=".55"/>
      <text x="20" y="34" font-size="13" fill="var(--muted)">Draußen</text>
      <text x="20" y="62" font-size="28" font-weight="700" fill="var(--text)">${ft(aussen)}</text>

      <!-- Außeneinheit -->
      <g class="klick" data-mehr="${E.kompressor || ''}">
        <rect x="30" y="220" width="140" height="110" rx="12" fill="var(--card2)" stroke="var(--line)" stroke-width="2"/>
        <circle cx="80" cy="275" r="36" fill="var(--card)"/>
        <g class="${hz > 0 ? 'dreh' : ''}" style="animation-duration:${hz > 0 ? Math.max(0.2, 2 - hz / 60).toFixed(2) : 0}s">
          <path d="M80 275 L80 243 Q96 252 80 275 M80 275 L110 285 Q98 300 80 275 M80 275 L54 293 Q50 276 80 275" fill="var(--muted)"/></g>
        <text x="100" y="352" text-anchor="middle" font-size="13" fill="var(--muted)">Kompressor</text>
        <text x="100" y="372" text-anchor="middle" font-size="16" font-weight="700" fill="var(--text)">${hz > 0 ? fz(hz, 0) + ' Hz' : 'aus'}</text>
      </g>

      <!-- Leitungen zur Inneneinheit -->
      <path d="M170 250 H260" stroke="${farbe(vl)}" stroke-width="8" stroke-linecap="round"/>
      <path d="M170 300 H260" stroke="${farbe(rl)}" stroke-width="8" stroke-linecap="round"/>
      ${hz > 0 ? `<path d="M170 250 H260" class="fluss" stroke="#fff" stroke-width="3" style="animation-duration:.9s"/>` : ''}

      <!-- Inneneinheit mit Speicher -->
      <g class="klick" data-mehr="${E.wwOben || ''}">
        <rect x="260" y="110" width="150" height="270" rx="14" fill="var(--card2)" stroke="var(--line)" stroke-width="2"/>
        <text x="335" y="134" text-anchor="middle" font-size="13" fill="var(--muted)">Warmwasser</text>
        <rect x="288" y="146" width="94" height="190" rx="40" fill="var(--card)" stroke="var(--line)" stroke-width="2"/>
        <rect x="292" y="${150 + 182 * (1 - wwFill)}" width="86" height="${182 * wwFill}" rx="36" fill="url(#wwGrad)"/>
        <text x="335" y="250" text-anchor="middle" font-size="22" font-weight="700" fill="#fff" style="paint-order:stroke" stroke="rgba(0,0,0,.25)" stroke-width="3">${wwO != null ? fz(wwO, 0) + '°' : KA}</text>
        <text x="335" y="362" text-anchor="middle" font-size="13" fill="var(--muted)">${esc('Wärmepumpe ' + prioText)}</text>
      </g>

      <!-- Fußbodenheizung -->
      <g class="klick" data-mehr="${E.vorlauf || ''}">
        <path d="M410 200 H470 V360" stroke="${farbe(vl)}" stroke-width="7" fill="none" stroke-linecap="round"/>
        <path d="M410 230 H450 V380 H860" stroke="${farbe(rl)}" stroke-width="7" fill="none" stroke-linecap="round" opacity=".9"/>
        <path d="M470 360 ${Array.from({length: 7}, (_, i) => `H${510 + i * 50} V${i % 2 ? 360 : 340}`).join(' ')} H860 V380" stroke="url(#fbh)" stroke-width="6" fill="none"/>
        <linearGradient id="fbh" x1="0" x2="1"><stop offset="0" stop-color="${farbe(vl)}"/><stop offset="1" stop-color="${farbe(rl)}"/></linearGradient>
        ${hz > 0 || (vl != null && rl != null && vl - rl > 1.5) ? `<path d="M470 360 ${Array.from({length: 7}, (_, i) => `H${510 + i * 50} V${i % 2 ? 360 : 340}`).join(' ')} H860" class="fluss" stroke="#fff" stroke-width="2.5" fill="none" style="animation-duration:1.4s"/>` : ''}
        <rect x="460" y="330" width="420" height="4" fill="var(--line)"/>
        <text x="480" y="406" font-size="13" fill="var(--muted)">Vorlauf <tspan font-weight="700" fill="var(--text)">${ft(vl)}</tspan>   Rücklauf <tspan font-weight="700" fill="var(--text)">${ft(rl)}</tspan>${E.vorlaufSoll ? `   Soll <tspan font-weight="700" fill="var(--text)">${ft(t(E.vorlaufSoll))}</tspan>` : ''}</text>
      </g>

      <!-- Raum -->
      <g class="klick" data-mehr="${E.raum || ''}">
        <path d="M480 320 V160 L670 70 L860 160 V320" fill="none" stroke="var(--line)" stroke-width="3"/>
        <text x="670" y="210" text-anchor="middle" font-size="13" fill="var(--muted)">Innen</text>
        <text x="670" y="250" text-anchor="middle" font-size="40" font-weight="700" fill="var(--text)">${raum != null ? fz(raum, 1) + '°' : KA}</text>
        ${E.raumSoll ? `<text x="670" y="276" text-anchor="middle" font-size="13" fill="var(--muted)">Ziel ${fz(t(E.raumSoll), 1)} °C</text>` : ''}
      </g>

      <!-- Lüftung -->
      <g class="klick" data-mehr="${E.luefter || E.abluft || ''}">
        <rect x="890" y="110" width="90" height="200" rx="12" fill="var(--card2)" stroke="var(--line)" stroke-width="2"/>
        <text x="935" y="132" text-anchor="middle" font-size="13" fill="var(--muted)">Lüftung</text>
        <circle cx="935" cy="180" r="28" fill="var(--card)"/>
        <g class="${luef ? 'dreh' : ''}" style="animation-duration:${luftDauer.toFixed(2)}s"><path d="M935 180 L935 156 Q948 164 935 180 M935 180 L957 188 Q948 199 935 180 M935 180 L915 193 Q911 180 935 180" fill="var(--accent)"/></g>
        <text x="935" y="228" text-anchor="middle" font-size="15" font-weight="700" fill="var(--text)">${luef != null ? fz(luef, 0) + ' %' : KA}</text>
        <path d="M860 150 H888" stroke="#e8590c" stroke-width="5" class="fluss" style="animation-duration:${luef ? 1 : 0}s"/>
        <text x="886" y="104" text-anchor="end" font-size="12" fill="var(--muted)">Abluft ${ab != null ? fz(ab, 1) + '°' : ''}</text>
        <path d="M935 310 V340" stroke="#3b82f6" stroke-width="5" class="fluss" style="animation-duration:${luef ? 1 : 0}s"/>
        <text x="935" y="358" text-anchor="middle" font-size="12" fill="var(--muted)">Fortluft ${fort != null ? fz(fort, 1) + '°' : ''}</text>
        ${zu != null ? `<text x="935" y="290" text-anchor="middle" font-size="12" fill="var(--muted)">Zuluft ${fz(zu, 1)}°</text>` : ''}
      </g>
    </svg>`;

    let gmBalken = '';
    if (gm != null) {
      const start = gmStart != null ? gmStart : -60;
      const anteil = Math.max(0, Math.min(1, gm / start));
      gmBalken = `<div class="feld"><div class="zeile"><span class="l" style="color:var(--muted);font-size:13px">Wärmebedarf (Gradminuten)</span><b data-mehr="${E.gm}" style="cursor:pointer">${fz(gm, 0)} GM</b></div>
        <div class="balken"><i style="width:${(anteil * 100).toFixed(0)}%;background:${anteil > .8 ? 'var(--heat)' : 'var(--accent)'}"></i></div>
        <div class="hinweis" style="margin-top:4px">Der Kompressor startet bei ${fz(start, 0)} GM. ${anteil >= 1 ? 'Grenze erreicht.' : `Noch ${fz(Math.max(0, gm - start), 0)} bis zum Start.`}</div></div>`;
    }

    return `
      <div class="kopf"><div><h1>Wärme &amp; Luft</h1><div class="unter">Die Wärmepumpe ${esc(prioText)}${E.wpLeistung ? ' und braucht ' + fw(watt(E.wpLeistung)) : ''}.</div></div>
        <div class="wetter"><b>${raum != null ? fz(raum, 1) + '°' : ''}</b><span>innen<br>${aussen != null ? fz(aussen, 1) + '° draußen' : ''}</span></div></div>
      <div class="karte" style="padding:8px">${svg}</div>
      <div class="abstand"></div>
      <div class="raster" style="grid-template-columns:repeat(auto-fit,minmax(320px,1fr))">
        <div class="karte"><h2>Heizen</h2>
          ${stepper(E.raumSoll, 'Wunschtemperatur innen', '°C')}
          ${stepper(E.offset, 'Heizkurve verschieben (wärmer oder kühler)', '')}
          ${segment(E.betriebsart, 'Betriebsart')}
          ${segment(E.zusatz, 'Elektrische Zusatzheizung höchstens')}
          ${gmBalken}
        </div>
        <div class="karte"><h2>Warmwasser &amp; Lüftung</h2>
          ${segment(E.wwBedarf, 'Warmwasser-Menge')}
          ${segment(E.wwExtra, 'Warmwasser extra (einmalig mehr)')}
          ${segment(E.luftStufe, 'Lüftungsstufe')}
          <div class="werte">
            ${wertBox('Warmwasser oben', wwO != null ? fz(wwO, 1) : KA, '°C', E.wwOben)}
            ${wertBox('Warmwasser Mitte', wwL != null ? fz(wwL, 1) : KA, '°C', E.wwLade)}
            ${wertBox('Abluft', ab != null ? fz(ab, 1) : KA, '°C', E.abluft)}
            ${wertBox('Zuluft', zu != null ? fz(zu, 1) : KA, '°C', E.zuluft)}
          </div>
        </div>
      </div>
      <p class="hinweis" style="margin:12px 4px 0">Alle Fachwerte und Experten-Einstellungen findest du weiter unten.</p>`;
  }

  // ---------------------------------------------------------------- Seite: Mobilität

  function seiteMobil() {
    const en = energieJetzt();
    const ueberschuss = en.einspeisung || 0;
    const karten = en.wbs.map((wb, i) => {
      const s = st(wb.status);
      const p = watt(wb.leistung) || 0;
      const laedt = p > 50;
      const verbunden = wbVerbunden(wb);
      const status = s ? (WB_TEXT[s.state] || uebersetze(s.state)) : KA;
      const grund = wb.grund && nutzbar(wb.grund) && !laedt && verbunden ? uebersetze(st(wb.grund).state) : '';
      const auto = `<svg viewBox="0 0 300 120" style="width:100%;display:block">
        <rect x="0" y="104" width="300" height="6" rx="3" fill="var(--line)"/>
        <rect x="14" y="20" width="22" height="86" rx="5" fill="var(--text)" opacity=".85"/>
        <rect x="18" y="28" width="14" height="22" rx="4" fill="${laedt ? '#00d2ff' : verbunden ? '#7ee787' : '#7a828e'}" ${laedt ? 'class="puls"' : ''}/>
        ${verbunden ? `<path d="M30 70 Q60 110 92 84" stroke="var(--text)" stroke-width="4" fill="none"/>
          <g transform="translate(80,38)"><path d="M8 52 Q4 32 22 26 L44 8 Q50 3 60 3 L118 3 Q130 3 138 13 L156 30 Q176 33 176 48 L176 56 Q176 62 170 62 L12 62 Q6 62 8 52Z" fill="${i ? '#c0392b' : '#3a6ea5'}"/>
          <path d="M50 11 L64 11 L64 27 L36 27Z M72 11 L114 11 Q122 11 128 19 L136 27 L72 27Z" fill="var(--card2)"/>
          <circle cx="40" cy="62" r="14" fill="#1f2328"/><circle cx="40" cy="62" r="5" fill="#9aa4b2"/>
          <circle cx="142" cy="62" r="14" fill="#1f2328"/><circle cx="142" cy="62" r="5" fill="#9aa4b2"/>
          ${laedt ? `<path d="M96 18 l-10 18 h10 l-7 17 l20 -23 h-10 l7 -12z" fill="#ffe14d" class="puls"/>` : ''}</g>` :
          `<rect x="90" y="46" width="180" height="56" rx="14" fill="none" stroke="var(--line)" stroke-width="3" stroke-dasharray="8 8"/>
           <text x="180" y="80" text-anchor="middle" font-size="14" fill="var(--muted)">Stellplatz frei</text>`}
      </svg>`;
      return `<div class="karte"><h2>${esc(wb.name)}${wb.bereich ? `<span class="hinweis" style="font-weight:400">${esc(wb.bereich)}</span>` : ''}<span class="mehr" data-mehr="${wb.status || ''}">Details</span></h2>
        ${auto}
        <div class="zeile" style="margin:8px 2px 12px"><b style="font-size:18px">${esc(laedt ? 'Lädt mit ' + fw(p) : status)}</b>${grund ? `<span class="hinweis">${esc(grund)}</span>` : ''}</div>
        <div class="werte">
          ${wertBox('Diese Ladung', fz(zahl(wb.sitzung), 1), 'kWh', wb.sitzung)}
          ${wb.kostenTag ? wertBox('Kosten heute', fz(zahl(wb.kostenTag), 2), '€', wb.kostenTag) : ''}
          ${wb.kostenMonat ? wertBox('Kosten Monat', fz(zahl(wb.kostenMonat), 2), '€', wb.kostenMonat) : ''}
          ${wb.kostenJahr ? wertBox('Kosten Jahr', fz(zahl(wb.kostenJahr), 0), '€', wb.kostenJahr) : ''}
          ${wb.strom ? wertBox('Strom', fz(zahl(wb.strom), 1), 'A', wb.strom) : ''}
          ${wb.phasen ? wertBox('Phasen', esc(uebersetze(st(wb.phasen).state)), '', wb.phasen) : ''}
        </div>
        <div style="margin-top:10px">
          ${kipp(wb.erlaubt, 'Laden erlaubt', 'Aus heißt: Die Wallbox gibt keinen Strom ab.')}
          ${kipp(wb.smart, 'Smart Charging', 'Lädt bevorzugt, wenn Strom günstig ist.')}
          ${kipp(wb.verriegelt, 'Kabel fest verriegelt', 'Das Kabel bleibt auch ohne Auto in der Wallbox.')}
          ${kipp(wb.einfZeitplan, 'Einfacher Zeitplan')}
          ${kipp(wb.wochenZeitplan, 'Wochenzeitplan')}
          ${kipp(wb.licht, 'Licht an der Wallbox')}
        </div>
        ${wb.zeitplan ? `<div class="knoepfe" style="margin-top:10px"><button class="knopf" data-dienst='${esc(JSON.stringify(['button', 'press', {entity_id: wb.zeitplan}]))}'>Jetzt laden, Zeitplan ignorieren</button></div>` : ''}
      </div>`;
    }).join('');
    return `
      <div class="kopf"><div><h1>Mobilität</h1><div class="unter">${ueberschuss > 300 ? `Gerade ${fw(ueberschuss)} Sonnenstrom übrig, gut zum Laden.` : en.pv > 0 ? 'Die Sonne reicht gerade für das Haus, kaum Überschuss.' : 'Gerade kein Sonnenstrom.'}</div></div>
        <div class="wetter"><b>${fw(en.autos)}</b><span>laden<br>gerade</span></div></div>
      <div class="raster" style="grid-template-columns:repeat(auto-fit,minmax(320px,1fr))">${karten || '<div class="karte">Keine Wallbox gefunden.</div>'}</div>`;
  }

  // ---------------------------------------------------------------- Seite: Haushalt

  const GERAET_EMOJI = {waschmaschine: '🧺', trockner: '🌀', spueler: '🍽️', ofen: '🔥', stecker: '🔌'};

  function seiteHaushalt() {
    const gs = hausgeraete();
    const gross = gs.filter(g => g.art !== 'stecker');
    const stecker = gs.filter(g => g.art === 'stecker');
    const karte = g => {
      const l = geraetLage(g);
      const farbe = l.stoerung ? 'var(--bad)' : l.fertig ? 'var(--ok)' : l.laeuft ? 'var(--accent)' : 'var(--line)';
      const innen = l.prozent != null && l.laeuft ? Math.round(l.prozent) + '%' : (GERAET_EMOJI[g.art] || '•');
      const knoepfe = [];
      if (g.start && nutzbar(g.start)) knoepfe.push(['Starten', g.start]);
      if (g.pause && nutzbar(g.pause)) knoepfe.push(['Pause', g.pause]);
      if (g.stopp && nutzbar(g.stopp)) knoepfe.push(['Stopp', g.stopp]);
      return `<div class="karte"><div class="geraet">
          ${ring(l.laeuft ? (l.prozent != null ? l.prozent : 50) : l.fertig ? 100 : 0, farbe, innen)}
          <div style="flex:1;min-width:0">
            <div class="name">${esc(g.name)}</div>
            <div class="${l.fertig ? 'fertig' : 'stand'}">${esc(l.text)}${l.programm ? ', ' + esc(l.programm) : ''}${l.phase ? ', ' + esc(l.phase) : ''}</div>
            ${l.laeuft && l.rest != null ? `<div class="gross">noch ${dauer(l.rest)}</div>` : ''}
            ${l.laeuft && l.ende ? `<div class="hinweis">fertig um ${uhr(l.ende)} Uhr</div>` : ''}
          </div>
          <span class="mehr" data-mehr="${g.zustand || g.ids[0]}" style="cursor:pointer;color:var(--accent);font-size:13px">Details</span>
        </div>
        ${g.tuer && st(g.tuer) ? `<div class="hinweis" style="margin-top:8px">Tür ${['on', 'open'].includes(st(g.tuer).state) ? 'offen' : 'zu'}</div>` : ''}
        ${g.schalter ? kipp(g.schalter, 'Eingeschaltet') : ''}
        ${knoepfe.length ? `<div class="knoepfe" style="margin-top:10px">${knoepfe.map(([t, id]) => `<button class="knopf" data-dienst='${esc(JSON.stringify(['button', 'press', {entity_id: id}]))}'>${t}</button>`).join('')}</div>` : ''}
      </div>`;
    };
    const steckerKarte = g => {
      const w = watt(g.leistung);
      const e = zahl(g.energie);
      const laeuft = w != null && w > 5;
      return `<div class="karte"><div class="geraet">${ring(laeuft ? Math.min(100, w / 25) : 0, laeuft ? 'var(--accent)' : 'var(--line)', laeuft ? '⚡' : '🔌')}
        <div style="flex:1"><div class="name">${esc(g.name)}</div><div class="gross">${fw(w)}</div><div class="hinweis">${e != null ? 'insgesamt ' + fwh(e) : ''}</div></div>
        <span class="mehr" data-mehr="${g.leistung}" style="cursor:pointer;color:var(--accent);font-size:13px">Verlauf</span></div>
        ${g.schalter ? kipp(g.schalter, 'Strom an der Steckdose', 'Aus trennt das Gerät vom Strom.') : ''}</div>`;
    };
    const aktiv = gross.filter(g => geraetLage(g).laeuft).length;
    return `
      <div class="kopf"><div><h1>Haushalt</h1><div class="unter">${aktiv ? (aktiv === 1 ? 'Ein Gerät läuft gerade.' : aktiv + ' Geräte laufen gerade.') : 'Alle Geräte ruhen.'}</div></div></div>
      <div class="raster">${gross.map(karte).join('')}</div>
      ${stecker.length ? `<div class="abstand"></div><h2 style="margin:4px 6px 10px;font-size:16px">Strommessung an Steckdosen</h2><div class="raster">${stecker.map(steckerKarte).join('')}</div>` : ''}`;
  }

  // ---------------------------------------------------------------- Zeichnen und Bedienen

  const SEITEN = {haus: seiteHaus, energie: seiteEnergie, waerme: seiteWaerme, mobil: seiteMobil, haushalt: seiteHaushalt};

  function zeichne() {
    if (!hass) return;
    const fn = SEITEN[SEITE] || seiteHaus;
    let html;
    try { html = fn(); } catch (e) { console.error(e); html = `<div class="karte">Diese Ansicht konnte nicht gezeichnet werden: ${esc(e.message)}</div>`; }
    if (html === letztesHtml) return;
    letztesHtml = html;
    app.className = '';
    app.innerHTML = html;
    passeAn();
  }

  function passeAn() {
    const fe = window.frameElement;
    if (!fe) return;
    const h = Math.ceil(document.documentElement.scrollHeight);
    fe.style.height = h + 'px';
    fe.style.position = 'static';
    fe.setAttribute('scrolling', 'no');
    const huelle = fe.parentElement;
    if (huelle && huelle.style) { huelle.style.paddingTop = '0'; huelle.style.height = 'auto'; }
    const wurzel = fe.getRootNode && fe.getRootNode();
    const karte = wurzel && wurzel.querySelector && wurzel.querySelector('ha-card');
    if (karte) { karte.style.background = 'transparent'; karte.style.boxShadow = 'none'; karte.style.border = 'none'; karte.style.height = 'auto'; }
    if (wurzel && wurzel.host) wurzel.host.style.height = 'auto';
  }

  document.addEventListener('click', ev => {
    const el = ev.target.closest('[data-dienst],[data-mehr],[data-nav]');
    if (!el || el.disabled) return;
    if (el.dataset.dienst) {
      const [d, s, data] = JSON.parse(el.dataset.dienst);
      el.style.opacity = '.6';
      dienst(d, s, data).catch(e => alarm(e)).finally(() => { el.style.opacity = ''; });
    } else if (el.dataset.mehr) {
      mehr(el.dataset.mehr);
    } else if (el.dataset.nav) {
      gehe(el.dataset.nav + (el.dataset.anker ? '#' + el.dataset.anker : ''));
    }
  });

  function alarm(e) {
    const t = document.createElement('div');
    t.className = 'karte';
    t.style.cssText = 'position:fixed;left:12px;right:12px;bottom:12px;color:var(--bad);z-index:9';
    t.textContent = 'Das hat nicht geklappt: ' + ((e && (e.message || e.error)) || e);
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 5000);
  }

  function takt() {
    const el = haEl();
    const neu = el && el.hass;
    if (neu && neu !== letzterHass) {
      const erstes = !hass;
      hass = neu; letzterHass = neu;
      document.documentElement.classList.toggle('dunkel', !!(hass.themes && hass.themes.darkMode));
      if (erstes) rollen();
      zeichne();
    }
  }

  try {
    if (!haEl()) throw new Error('kein Home Assistant');
  } catch (e) {
    app.textContent = 'Diese Seite funktioniert nur innerhalb von Home Assistant.';
    return;
  }
  takt();
  setInterval(takt, 1000);
  setInterval(() => { rollen(); letztesHtml = ''; zeichne(); }, 60000);
  new ResizeObserver(passeAn).observe(document.body);
  window.addEventListener('resize', () => { letztesHtml = ''; zeichne(); });
})();
