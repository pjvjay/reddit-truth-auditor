/** Shared references to the panel's DOM and view state (filled in by panel.js). */
export const ui = {
  host: null,
  shadow: null,
  panel: null,
  launcher: null,
  tabs: null,
  views: null,
  listScroll: null,
  list: null, //        live cards
  empty: null,
  banners: null,
  history: null,
  trends: null,
  settingsView: null,
  usage: null,
  counters: {}, //      tab badges, launcher count, status text…
  cards: new Map(), //  id -> card element
  isOpen: false,
  tab: 'live', //       live | flagged | history | trends
};
