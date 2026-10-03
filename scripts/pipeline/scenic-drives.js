// Scenic drives (v0.21): famous routes you can complete, per region. Built
// into each region's scenic.json by scenic.js, so a new drive here reaches
// phones with the next road-data build, no app update needed.
//
// A drive's roads come from either:
//   relation  OpenStreetMap route relations whose name matches (with their
//             sub-relations), e.g. the Wild Atlantic Way's county stages
//   roads     road numbers ("R115") or names ("Sky Road"), each limited to
//             a box [south, west, north, east] so only the stretch that's
//             part of the drive counts. Slip roads and roundabouts are left
//             out (you can't drive all of them on one trip).
// A drive whose roads aren't found (renamed in OSM, say) is left out of the
// build with a warning, never published empty.
//
//   id     never change once published (phones keep progress by it)
//   need   share of the route that completes it (1 = every road on it)

const SCENIC = {
  ie: [
    {
      id: 'wild-atlantic-way',
      name: 'Wild Atlantic Way',
      where: 'Donegal to Cork',
      blurb: "The west coast end to end: Ireland's longest touring route.",
      need: 1,
      relation: /^Wild Atlantic Way\b/,
    },
    {
      id: 'ring-of-kerry',
      name: 'Ring of Kerry',
      where: 'Kerry',
      blurb: 'Killarney, Killorglin, Cahersiveen, Waterville, Sneem and Kenmare, round the Iveragh peninsula.',
      need: 1,
      roads: [
        { ref: 'N70', box: [51.7, -10.42, 52.115, -9.55] },
        { ref: 'N71', box: [51.875, -9.68, 52.065, -9.49] },
        { ref: 'N72', box: [52.04, -9.8, 52.115, -9.5] },
      ],
    },
    {
      id: 'ring-of-beara',
      name: 'Ring of Beara',
      where: 'Cork and Kerry',
      blurb: 'Glengarriff, Castletownbere, Allihies and Eyeries, then back over the Caha Pass.',
      need: 1,
      roads: [
        { ref: 'R571', box: [51.6, -10.2, 51.89, -9.55] },
        { ref: 'R572', box: [51.55, -10.25, 51.77, -9.45] },
        { ref: 'R575', box: [51.6, -10.2, 51.75, -9.85] },
        { ref: 'N71', box: [51.74, -9.62, 51.875, -9.53] },
      ],
    },
    {
      id: 'military-road',
      name: 'Military Road & Sally Gap',
      where: 'Wicklow',
      blurb: 'Glencree to Laragh across the bog, through the Sally Gap crossroads.',
      need: 1,
      roads: [{ ref: 'R115', box: [53.0, -6.4, 53.21, -6.24] }],
    },
    {
      id: 'wicklow-gap',
      name: 'Wicklow Gap',
      where: 'Wicklow',
      blurb: 'Laragh to Hollywood over the mountains, past Glendalough.',
      need: 1,
      roads: [{ ref: 'R756', box: [53.0, -6.62, 53.1, -6.3] }],
    },
    {
      id: 'slea-head',
      name: 'Slea Head Drive',
      where: 'Kerry',
      blurb: 'Round the end of the Dingle peninsula from Dingle town.',
      need: 1,
      roads: [{ ref: 'R559', box: [52.07, -10.5, 52.22, -10.24] }],
    },
    {
      id: 'conor-pass',
      name: 'Conor Pass',
      where: 'Kerry',
      blurb: "Ireland's highest mountain pass road, from Dingle over to the north side.",
      need: 1,
      roads: [{ ref: 'R560', box: [52.14, -10.29, 52.235, -10.14] }],
    },
    {
      id: 'healy-pass',
      name: 'Healy Pass',
      where: 'Cork and Kerry',
      blurb: 'The zig-zag road over the Caha Mountains, Lauragh to Adrigole.',
      need: 1,
      roads: [{ ref: 'R574', box: [51.6, -9.9, 51.8, -9.6] }],
    },
    {
      id: 'sky-road',
      name: 'Sky Road',
      where: 'Galway',
      blurb: 'The cliff-top loop west of Clifden.',
      need: 1,
      roads: [{ name: 'Sky Road', box: [53.46, -10.25, 53.53, -9.99] }],
    },
    {
      id: 'copper-coast',
      name: 'Copper Coast',
      where: 'Waterford',
      blurb: 'Tramore to Dungarvan along the coves and old mine country.',
      need: 1,
      roads: [{ ref: 'R675', box: [52.07, -7.66, 52.18, -7.11] }],
    },
    {
      id: 'the-vee',
      name: 'The Vee',
      where: 'Tipperary and Waterford',
      blurb: 'Clogheen to Lismore over the Knockmealdowns, round the famous hairpin.',
      need: 1,
      roads: [{ ref: 'R668', box: [52.13, -8.03, 52.285, -7.87] }],
    },
    {
      id: 'ring-of-hook',
      name: 'Ring of Hook',
      where: 'Wexford',
      blurb: 'Down the Hook peninsula to the lighthouse and back.',
      need: 1,
      roads: [{ ref: 'R734', box: [52.1, -6.98, 52.27, -6.8] }],
    },
    {
      id: 'glengesh-pass',
      name: 'Glengesh Pass',
      where: 'Donegal',
      blurb: 'The pass between Ardara and Glencolumbkille.',
      need: 1,
      roads: [{ ref: 'R230', box: [54.66, -8.7, 54.76, -8.4] }],
    },
    {
      id: 'inishowen-100',
      name: 'Inishowen 100',
      where: 'Donegal',
      blurb: 'A hundred miles round the Inishowen peninsula, out to Malin Head.',
      need: 1,
      relation: /^Inishowen 100\b/,
    },
    {
      id: 'causeway-coast',
      name: 'Causeway Coastal Route',
      where: 'Antrim and Londonderry',
      blurb: 'Larne to Portstewart round the Glens, past the Giant\'s Causeway.',
      need: 1,
      relation: /^Causeway Coastal Route\b/,
      roads: [{ ref: 'A2', box: [54.83, -6.76, 55.25, -5.75] }],
    },
    {
      id: 'mourne-coast',
      name: 'Mourne Coastal Route',
      where: 'Down',
      blurb: 'Newcastle to Warrenpoint between the Mournes and the sea.',
      need: 1,
      roads: [{ ref: 'A2', box: [54.0, -6.32, 54.23, -5.85] }],
    },
  ],
};

module.exports = { SCENIC };
