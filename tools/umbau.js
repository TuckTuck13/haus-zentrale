// Baut das Dashboard "haus-zentrale" um. Wird im Browser auf der Home-Assistant-Seite ausgeführt.
// Die Pfade der Ansichten bleiben gleich, damit Links aus Benachrichtigungen weiter passen.
// Vorher wird die alte Fassung als verstecktes Dashboard "zentrale-sicherung" gespeichert.
// Nichts geht verloren: Alle bisherigen Abschnitte wandern unter die neuen Grafiken.
async function zentraleUmbauen({dashboard = 'haus-zentrale', sicherung = 'zentrale-sicherung', probe = false} = {}) {
  const hass = document.querySelector('home-assistant').hass;
  // Quelle ist immer die gesicherte Ursprungsfassung, damit der Umbau beliebig oft laufen kann.
  const boards = await hass.callWS({type: 'lovelace/dashboards/list'});
  let quelle;
  if (boards.some(b => b.url_path === sicherung)) {
    quelle = await hass.callWS({type: 'lovelace/config', url_path: sicherung});
  } else {
    quelle = await hass.callWS({type: 'lovelace/config', url_path: dashboard});
    if (!probe) {
      await hass.callWS({type: 'lovelace/dashboards/create', url_path: sicherung, title: 'Zentrale (Sicherung)',
        icon: 'mdi:backup-restore', mode: 'storage', show_in_sidebar: false, require_admin: true});
      await hass.callWS({type: 'lovelace/config/save', url_path: sicherung, config: quelle});
    }
  }

  const v = p => JSON.parse(JSON.stringify(quelle.views.find(x => x.path === p) || {sections: []}));
  const grafik = (seite, extra) => ({type: 'grid', column_span: 4, cards: [{
    type: 'iframe', url: `/local/zentrale/index.html?s=${seite}`, disable_sandbox: true,
    grid_options: {columns: 'full', rows: 'auto'}, ...(extra || {})}]});
  const trenner = (titel, text) => ({type: 'grid', column_span: 4, cards: [
    {type: 'heading', heading: titel, heading_style: 'title'}, ...(text ? [{type: 'markdown', content: text}] : [])]});
  const ansicht = (path, title, icon, sections) => ({path, title, icon, type: 'sections', max_columns: 4, sections});

  // Räume aus den Bereichen erzeugen
  const S = hass.states, ent = hass.entities, dev = hass.devices;
  const bereich = id => (ent[id] && (ent[id].area_id || (dev[ent[id].device_id] || {}).area_id)) || null;
  const versteckt = id => ent[id] && (ent[id].hidden || ent[id].entity_category);
  const raeume = Object.values(hass.areas).sort((a, b) => a.name.localeCompare(b.name, 'de')).map(a => {
    const ids = Object.keys(S).filter(e => bereich(e) === a.area_id && !versteckt(e));
    const karten = [];
    for (const e of ids.filter(e => e.startsWith('light.'))) karten.push({type: 'tile', entity: e, features: [{type: 'light-brightness'}], features_position: 'bottom', grid_options: {columns: 6}});
    for (const e of ids.filter(e => e.startsWith('scene.'))) karten.push({type: 'tile', entity: e, icon: 'mdi:palette', tap_action: {action: 'perform-action', perform_action: 'scene.turn_on', target: {entity_id: e}}, grid_options: {columns: 6}});
    for (const e of ids.filter(e => e.startsWith('media_player.') || e.startsWith('climate.') || e.startsWith('cover.') || e.startsWith('fan.'))) karten.push({type: 'tile', entity: e, grid_options: {columns: 12}});
    for (const e of ids.filter(e => e.startsWith('sensor.') && ['temperature', 'humidity', 'illuminance', 'carbon_dioxide'].includes(S[e].attributes.device_class))) karten.push({type: 'tile', entity: e, grid_options: {columns: 6}});
    for (const e of ids.filter(e => e.startsWith('binary_sensor.') && ['motion', 'occupancy', 'presence', 'door', 'window', 'opening'].includes(S[e].attributes.device_class))) karten.push({type: 'tile', entity: e, grid_options: {columns: 6}});
    for (const e of ids.filter(e => e.startsWith('camera.'))) karten.push({type: 'picture-entity', entity: e, camera_view: 'auto', show_state: false});
    if (!karten.length) return null;
    return {type: 'grid', cards: [{type: 'heading', heading: a.name, icon: a.icon || 'mdi:sofa'}, ...karten]};
  }).filter(Boolean);

  const aliaswacht = S['sensor.aliaswacht_offen'] ? [{type: 'grid', cards: [
    {type: 'heading', heading: 'Aliaswacht', icon: 'mdi:email-lock'},
    ...['offen', 'freigegeben', 'gesperrt', 'verdaechtig'].filter(k => S['sensor.aliaswacht_' + k]).map(k => ({type: 'tile', entity: 'sensor.aliaswacht_' + k, grid_options: {columns: 6}, tap_action: {action: 'navigate', navigation_path: '/aliaswacht-uebersicht'}})),
    {type: 'tile', entity: 'sensor.aliaswacht_status', grid_options: {columns: 12}},
    {type: 'button', name: 'Aliasse entscheiden', icon: 'mdi:gavel', tap_action: {action: 'navigate', navigation_path: '/aliaswacht-uebersicht'}, grid_options: {columns: 6, rows: 2}},
    ...(S['sensor.aliaswacht_status'].attributes.url ? [{type: 'button', name: 'Aliaswacht öffnen', icon: 'mdi:open-in-new', tap_action: {action: 'url', url_path: S['sensor.aliaswacht_status'].attributes.url}, grid_options: {columns: 6, rows: 2}}] : []),
  ]}] : [];

  const neu = {...quelle, views: [
    ansicht('uebersicht', 'Zuhause', 'mdi:home-heart', [grafik('haus'), trenner('Alle Statuswerte'), ...v('uebersicht').sections]),
    ansicht('licht', 'Räume & Licht', 'mdi:lightbulb-group', [grafik('raeume'), trenner('Alle Geräte nach Räumen'), ...raeume, trenner('Hue und Bewegungsmelder'), ...v('licht').sections]),
    ansicht('energie', 'Energie', 'mdi:solar-power-variant', [grafik('energie'), trenner('Werte und Speichersteuerung'), ...v('energie').sections]),
    ansicht('heizung', 'Wärme & Luft', 'mdi:heat-pump', [grafik('waerme'), trenner('Fachwerte und Experten-Einstellungen'), ...v('heizung').sections]),
    ansicht('wallboxen', 'Mobilität', 'mdi:ev-station', [grafik('mobil'), trenner('Alle Wallbox-Werte'), ...v('wallboxen').sections]),
    ansicht('haushalt', 'Haushalt', 'mdi:washing-machine', [grafik('haushalt'), trenner('Alle Gerätewerte'), ...v('haushalt').sections]),
    {...v('netzwerk'), path: 'netzwerk'},
    {...v('server'), path: 'server'},
    ansicht('kameras', 'Sicherheit', 'mdi:shield-home', [...v('kameras').sections, ...aliaswacht]),
    {...v('admin'), path: 'admin'},
  ]};
  if (probe) return neu;
  await hass.callWS({type: 'lovelace/config/save', url_path: dashboard, config: neu});
  return neu.views.map(x => x.title + ': ' + x.sections.length).join(', ');
}
