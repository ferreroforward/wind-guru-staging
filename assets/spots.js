// Wind Guru — spot database for the Strait of Georgia / Howe Sound / Metro
// Vancouver region.
// Each spot encodes the local meteorology needed by rules.js to tell thermal
// wind apart from synoptic/gradient wind, and to flag onshore vs offshore
// direction risk.
//
// regime types a spot can exhibit:
//   "thermal"   — local heating-driven wind (sea breeze / valley inflow), needs sun + weak gradient
//   "outflow"   — cold-air drainage / gap wind down a valley, gradient-driven, any time of day
//   "synoptic"  — general Strait of Georgia gradient wind ahead of / behind a front
//
// favorable_deg: [start,end] compass sector(s) considered rideable / safe onshore-to-cross-shore.
// Directions outside this sector are flagged as "offshore / not rideable" even if speed matches.
//
// Coordinates for every spot are the actual water-access/launch point Guillermo
// uses, not necessarily the beach's official/park coordinates — confirmed
// directly by him (Aug 2026), see individual spot comments for anything more
// specific than that.
//
// A few spots also carry `tide_note`, `direction_note`, or `current_note`
// fields — documentation-only local knowledge that isn't wired into
// classifyHour() (this app doesn't track tide state or current at all yet —
// see README "Known limitations"). They're captured here so a rider can
// apply them manually and so the config is a complete record of what's
// known, not just what the rule engine currently uses.

// Reference points for the Howe Sound pressure-gradient check (see
// rules.js). Inspired by kiteloop.vercel.app's "two independent gradients"
// MSLP panel: a large-scale coast-vs-interior spread (synoptic support) and
// a local channel spread (does the sound itself favor a pull toward the
// Spit). Our version reads Open-Meteo forecast MSLP rather than live SWOB
// station obs, so treat it as an approximation of the same idea, not a
// reproduction of that site's exact numbers.
export const PRESSURE_REFERENCE = {
  interior: { name: "Pemberton", lat: 50.3040, lon: -122.7960 },
  coastal: { name: "Vancouver", lat: 49.1967, lon: -123.1815 },
  howeSoundMouth: { name: "Point Atkinson", lat: 49.3300, lon: -123.2650 },
  // Far interior, for the learned Squamish thermal (Lillooet minus Vancouver temperature).
  far: { name: "Lillooet", lat: 50.6900, lon: -121.9300 },
};

export const SPOTS = [
  {
    // Coordinates updated (Aug 2026) to Guillermo's actual water-access
    // point, and the spot broadened to explicitly cover Nexen Beach — a
    // separate, actively-used launch a short distance away that came up
    // repeatedly in the North Shore Wing Group WhatsApp chat but wasn't in
    // our list. Rather than model it as a fully separate spot with no local
    // knowledge of its own beyond "people launch there too," it's folded in
    // here: same thermal/outflow/pressure-gradient system, same Squamish
    // corridor. Per the Van Kiteboard OSR Group chat, Nexen Beach itself
    // tends to run a bit lighter and patchier ("a lot of holes") than the
    // Spit proper, especially on marginal days — worth knowing even though
    // they share one entry here.
    id: "squamish-spit",
    // Swell index (rules.js swellForHours). currents: the compass direction
    // the water flows TOWARD on each tide, per Guillermo (Sep 2026): Floods north, ebbs south. Best riding on an incoming tide, but swell here is mostly fetch and time: 25 to 30kt for 3 hours builds the biggest swell. Less swell on a flood (it runs with the inflow).
    // fetchKm: rough open water distance upwind, by the direction the wind
    // comes from (map estimates, to be tuned from rider wave reports).
    currents: { flood: 0, ebb: 180 },
    swell: { fetchKm: [[[150, 260], 12], [[300, 40], 3]], defaultFetchKm: 5 },
    // Tide: Darrell Bay (nearest DFO station, 1.6km; Squamish Inner (1.8km) reads within ~0.05m). Rule: always the nearest DFO station,
    // except Steveston (Tsawwassen, see garry-point).
    tideStation: { code: "07808", id: "5cebf1e43d0f4a073c4bc40e", name: "Darrell Bay" },
    name: "Squamish (Spit & Nexen Beach)",
    region: "Howe Sound",
    lat: 49.682811, lon: -123.172443,
    marineZone: "howe_sound",
    sports: ["wingfoil", "kite", "windsurf"],
    level: "advanced",
    favorable_deg: [[150, 260]], // S–SW thermal inflow
    // Per Guillermo (Oct 2026): riders don't use the Spit on an outflow, so
    // any wind with north in it is never recommended here. The hours still
    // show (some go out by boat), marked as outflow, not inflow, and the spot
    // is left out of the best bets for them (rules.js classifyHour,
    // index.html).
    outflowNotRidden: { dirSector: [271, 89] },
    pressureGradientAware: true, // factor in MSLP gradient — see rules.js
    pamRocksAware: true, // use the live Pam Rocks nowcast on the current hour — see rules.js
    // Live wind meter at the Spit itself, published by Squamish Windsports
    // Society (squamishwindsports.com/conditions/wind) — genuinely observed,
    // not forecast, data, and per local rider feedback a far better read on
    // the Spit than Environment Canada's Squamish Airport station, which
    // sits in a wind shadow. generate.mjs compares this against the
    // forecast for the current hour and logs a mismatch if they disagree by
    // 20%+. See "Live verification" in README.
    liveStation: { type: "squamishwindsports", windSrc: "spit", name: "Squamish Spit wind meter" },
    thermal: {
      enabled: true,
      calibrated: true, // apply the local GFS-class-underread correction — see rules.js
      // Learned from the Spit meter: sun, temperature and pressure differences set
      // the number (applyThermalModel in rules.js). The 2.85x scaling above stays
      // as the fallback when the learned inputs are missing.
      learned: true,
      // Months the learned fit runs in. Trained on mid May to mid Sep; October
      // kept on after Oct 3 2026 (observed 13 to 15kt S from 2pm to 5pm, the
      // fit said 8.5kt, the models and the scaling 3 to 6kt). April has no
      // such check yet, so it stays on the models and the scaling.
      learnedMonths: [5,6,7,8,9,10],
      typicalDirDeg: 190,
      months: [4,5,6,7,8,9,10],
      hourWindow: [10, 19],
      dirSector: [150, 260], // S–SW up-sound
      note: "Classic Squamish summer thermal: valley heats, draws air up Howe Sound from the south. Builds late morning, peaks early-mid afternoon, dies at sunset. Needs sun + weak synoptic gradient — a mesoscale effect coarse global models often under-forecast."
    },
    outflow: {
      enabled: true,
      dirSector: [300, 40], // N–NNW outflow down-sound
      note: "Squamish outflow: cold, dense interior air drains down Howe Sound from the north. Gradient-driven, can occur any hour, often strong (20kt+) and gusty. Associated with high pressure building inland or a cold post-frontal airmass."
    }
  },
  {
    // Furry Creek used to be modeled as a separate spot, but it's right next
    // to Porteau Cove (~4km down-Sound, same exposure) — per local knowledge
    // they're effectively the same spot, so Furry Creek's thermal profile
    // was merged in here rather than kept as its own entry. Coordinates
    // refined (Aug 2026) to Guillermo's exact water-access point.
    id: "porteau-cove",
    // Swell index (rules.js swellForHours). currents: the compass direction
    // the water flows TOWARD on each tide, per Guillermo (Sep 2026): Same as Squamish: floods north, ebbs south.
    // fetchKm: rough open water distance upwind, by the direction the wind
    // comes from (map estimates, to be tuned from rider wave reports).
    currents: { flood: 0, ebb: 180 },
    swell: { fetchKm: [[[135, 260], 20], [[300, 40], 15]], defaultFetchKm: 6 },
    // Tide: Darrell Bay (nearest DFO station, 13km up Howe Sound). Rule: always the nearest DFO station,
    // except Steveston (Tsawwassen, see garry-point).
    tideStation: { code: "07808", id: "5cebf1e43d0f4a073c4bc40e", name: "Darrell Bay" },
    name: "Porteau Cove",
    region: "Howe Sound",
    lat: 49.560074, lon: -123.239163,
    marineZone: "howe_sound",
    sports: ["windsurf", "wingfoil"],
    level: "intermediate",
    favorable_deg: [[300, 40], [135, 260]], // N outflow, or S–SE–SW inflow/gradient wind
    pressureGradientAware: true,
    pamRocksAware: true, // SW-inflow-projection thermal nowcast on the current hour — see rules.js
    // Guillermo's rule (Sep 2026): "in an inflow you need at least 14 knots
    // reading [at Pam Rocks] for Porteau to work, on an outflow you need a
    // minimum of 25 to 30 knots". Used both for the live Pam Rocks reading
    // (current hour) and, through the learned Pam Rocks forecast below, for
    // every forecast hour. Sectors from a year of Pam Rocks readings at 14kt+:
    // inflows come from 130 to 230 degrees, outflows from 320 to 50.
    pamRocksRule: {
      // modelDirSector: the same flows as the models' own direction sees them
      // at Pam Rocks (a little wider; 87% of real outflow hours and 96% of
      // real inflow hours fall inside), used for forecast hours.
      inflow: { dirSector: [130, 230], modelDirSector: [125, 245], thresholdKt: 14 },
      outflow: { dirSector: [320, 50], modelDirSector: [295, 65], thresholdKt: 25 },
      worksAtKt: 12,
    },
    // Learned correction (rules.js applyMos, data/mos-coefficients.json):
    // fitted on a year of Pam Rocks hourly readings vs the day before models.
    // The blend forecasts Pam Rocks; pamRocksRule turns that into Porteau.
    // It replaces the borrowed Squamish thermal scaling here, since the rule
    // is Guillermo's own, specific to this spot.
    mos: { point: "pamrocks", overridesCalibration: true },
    calibrationSince: "2026-09-28",
    // Porteau sits further down-Sound, more open water than the Spit's
    // thermal/outflow convergence zone at the head of Howe Sound — Pam
    // Rocks (a Coast Guard station right at the Sound's entrance, found via
    // igetwind.com's station API — see README "Live verification") is a
    // more representative open-Sound reading for this spot than the Spit
    // meter would be, even though it's ~10km away.
    liveStation: { type: "igetwind", sid: "CWAS", lat: 49.48, lon: -123.30, name: "Pam Rocks (Howe Sound entrance)" },
    thermal: {
      enabled: true,
      calibrated: true, // same Howe Sound thermal system as Squamish Spit — see rules.js
      months: [5,6,7,8,9],
      hourWindow: [11, 18],
      dirSector: [150, 260],
      // Timing detail from the North Shore Wing Group chat (Chris, 2026-05-23):
      // "Porteau is not easy to predict. But when it's good I'll choose it
      // over Squamish every time. Tends to turn on around 11-noon this time
      // of year, often there is a lull when the tide changes, and often
      // surprise late day blow." Matches the hourWindow above; the tide-
      // change lull and late-day surprise aren't modeled (no tide data) but
      // worth knowing.
      note: "Secondary thermal channel down-Sound from the Spit — weaker and less reliable than Squamish itself; best on strong-thermal days. A NW wind reportedly mutes the inflow here even on an otherwise decent-looking day."
    },
    outflow: {
      enabled: true,
      dirSector: [300, 40],
      note: "Mid-Howe Sound outflow/gap-wind site — picks up the same north drainage flow as Squamish, usually a touch lighter and more consistent, less gusty than the Spit. Per local rider knowledge, a strong outflow here (25kt+) can be genuinely fun on its own, not just a lesser alternative to the thermal — chat history backs this up, with reported gusts over 40kt on a big outflow day."
    },
    tide_note: "A flooding tide can kill the swell here even when the wind itself is still working (per chat: \"flooding tide killed the swell today and made it tough to get on foil\") — not modeled (no tide data), but worth checking a tide table alongside the forecast."
  },
  {
    // Merged from two separate entries (Jericho Beach, Spanish Banks) into
    // one spot, per Guillermo (Aug 2026): "when we say Jericho we refer to
    // both Jericho and Spanish Banks, we usually get in the water where it
    // looks better" — i.e. these are treated as one go/no-go decision on the
    // water, not two independently-forecast spots. Coordinates are his
    // actual access point between the two beaches. Splitting calibration
    // history: this replaces the "jericho" and "spanish-banks" ids, so any
    // accumulated rider-feedback/live-verification history under those old
    // ids stops being read (a fresh id starts with no calibration bias,
    // same as any brand-new spot).
    id: "jericho-spanish-banks",
    // Swell index (rules.js swellForHours). currents: the compass direction
    // the water flows TOWARD on each tide, per Guillermo (Sep 2026): Floods east, ebbs west, so a W or NW wind runs against the ebb.
    // fetchKm: rough open water distance upwind, by the direction the wind
    // comes from (map estimates, to be tuned from rider wave reports).
    currents: { flood: 90, ebb: 270 },
    swell: { fetchKm: [[[240, 330], 35]], defaultFetchKm: 8 },
    name: "Jericho - Spanish Banks",
    // Water forecast point (Sep 28 2026): the beach cell is part land for
    // several models (NBM read 0.56x, HRRR 0.64x; kept 2km off the beach, since Jericho runs lighter than open English Bay vs a point further out, last 14 days, 8kt+ hours),
    // which reads the wind light. Same fix as Steveston.
    modelPoint: { lat: 49.29, lon: -123.26 },

    region: "English Bay",
    lat: 49.281646, lon: -123.235223,
    marineZone: "strait_of_georgia_south",
    marineAnchorFactor: 0.85,
    // EC often words the Strait bulletin "... except northwest 5 to 15 near
    // Vancouver"; that lighter wording is the one for English Bay. On Sep 25
    // 2026 the zone ran NW 20-30 while Jericho peaked at 17kt, which the
    // "near Vancouver" wording (scaled, see marineAnchorForHour) matches.
    marineExceptionAreas: ["near vancouver", "english bay"],
    // DFO Point Atkinson (07795), the reference port for English Bay.
    // See tide_note: low tide means a long walk to the water here.
    tideStation: { code: "07795", id: "5cebf1de3d0f4a073c4bb94c", name: "Point Atkinson" },
    sports: ["windsurf", "wingfoil", "kite"],
    level: "beginner-friendly",
    // Broadened from the old [230,320] westerly-thermal-only sector to
    // fully include NW (per local knowledge below, strong NW/W synoptic
    // wind — not just the afternoon sea breeze — produces the best waves
    // here).
    favorable_deg: [[230, 335]],
    // English Bay buoy (EC 46304) first: open water right off the beach.
    // Jericho Sailing Centre's own sensor (via wtfbc.ca's board) when the
    // buoy has nothing fresh. Per Guillermo, Sep 2026.
    liveStation: { code: "46304", name: "English Bay buoy", fallback: { type: "swob", boardName: "Jericho Sailing Centre", name: "Jericho Sailing Centre" } },
    calibrationSince: "2026-09-29",
    thermal: {
      enabled: true,
      months: [4,5,6,7,8,9],
      hourWindow: [11, 19],
      dirSector: [250, 300], // W/WNW sea breeze
      note: "English Bay sea breeze: sunny days with a weak gradient draw a westerly thermal onshore in the afternoon. Sheltered, flatter water on a typical thermal day — good learning venue."
    },
    outflow: { enabled: false },
    // Distinct from (and generally bigger than) the afternoon thermal above —
    // captures the "epic wave day" pattern the thermal-only dirSector alone
    // would miss, mirroring how Boundary Bay's synoptic_note works.
    synoptic_note: "The best/most epic wave days here come from strong NW or W synoptic wind, not just the afternoon thermal sea breeze — bigger fetch, bigger waves. Check the synoptic regime tag on a windy NW/W day, not just the thermal one.",
    tide_note: "Can foil at any tide, but it's a long walk to the water if the tide is lower than about 10ft. General principle from Guillermo (applies here and elsewhere): when the tide runs against the wind, waves get steeper — e.g. a W/NW wind against an outgoing tide makes for steeper, choppier waves than the same wind with the tide running the same direction. Duration matters too — wind blowing all night tends to build bigger waves by morning."
  },
  {
    // Replaced Iona Beach/Jetty (per local rider feedback — not a popular
    // spot) with Steveston/Garry Point Park, a few km south at the mouth of
    // the Fraser's South Arm. Coordinates refined (Aug 2026) to Guillermo's
    // exact water-access point.
    id: "garry-point",
    // Swell index (rules.js swellForHours). currents: the compass direction
    // the water flows TOWARD on each tide, per Guillermo (Sep 2026): Floods east, ebbs west (same as Jericho). The Fraser outflow adds to the ebb, which is why it gets a boost.
    // fetchKm: rough open water distance upwind, by the direction the wind
    // comes from (map estimates, to be tuned from rider wave reports).
    currents: { flood: 90, ebb: 270, ebbBoost: 1.3 },
    swell: { fetchKm: [[[180, 345], 40]], defaultFetchKm: 10 },
    name: "Steveston - Garry Point Park",
    region: "Fraser Delta",
    lat: 49.123665, lon: -123.196088,
    // Where we ask the weather models for wind, as opposed to lat/lon above
    // (the beach access, used for the map pin). The beach sits in a land
    // grid cell for every model, and land roughness cuts the forecast wind
    // hard: on Sep 25 2026 the day before runs gave ~3-4kt at the beach cell
    // for 9-10am (ECMWF) while the same runs gave 19-21kt over the water at
    // this point, and Sand Heads actually blew NNW 21 gusting 26. Riders
    // ride the water, and locals already read Sand Heads as the go/no-go, so
    // forecast for the water. This point (~5km WSW of the beach, inside Sand
    // Heads) is the closest one that is open water for GEM, GFS and ECMWF.
    modelPoint: { lat: 49.115, lon: -123.27 },
    // See dropModels() in rules.js: ICON only resolves land here.
    excludeModels: ["icon"],
    // Forecast point moved on this date, so calibration history learned
    // against the old (land) point no longer describes this forecast.
    calibrationSince: "2026-09-28",
    // Learned correction (rules.js applyMos, data/mos-coefficients.json):
    // fitted on a year of Sand Heads hourly readings vs the day before models.
    // Riders read Sand Heads as Steveston's number, so no offset.
    mos: { point: "garry", offsetKt: 0 },
    marineZone: "strait_of_georgia_south",
    marineAnchorFactor: 0.9,
    sports: ["kite", "windsurf", "wingfoil"],
    // Per Guillermo (Oct 2026): super advanced, never for beginners. Shown
    // on the card as a warning (caution_note, index.html cautionLine).
    level: "expert",
    // Shown but never recommended (Guillermo, Oct 10 2026, after local rider
    // feedback and the port rules): never a best bet, windiest pick, epic
    // headline or evening report pick; its card, map dot and forecast stay
    // for experienced locals (index.html, neverRecommend).
    neverRecommend: true,
    // Port rules (Vancouver Fraser Port Authority Boaters' Handbook, Oct
    // 2026): the South Arm is traffic control zone TCZ-4, the deep sea
    // channel plus 61m either side from 1nm past Sand Heads light to New
    // Westminster. Pleasure craft and sailing vessels must be under
    // mechanical power there; non motorized craft keep clear of the channel
    // and stay near shore; no loitering. Kiteboards: daylight only.
    caution_note: "Not recommended by Wind Guru; shown for experienced local riders only. Port rules: wind powered craft are not allowed in the Fraser River shipping channel or within 61m of it (traffic control zone, Sand Heads to New Westminster), so stay close to shore and clear of the channel. Kites daylight only. Expert riders only, never for beginners: know self rescue and maritime rules, always give way to the heavy commercial boat traffic, and don't ride alone, or at least carry a way to call emergency services.",
    // Widened to take in NNW: Guillermo's best ever session here (Sep 25
    // 2026) was in NNW 21 gusting 26 at Sand Heads. W, NW and SW remain the
    // core directions (see current_note).
    favorable_deg: [[180, 345]],
    // Tides from Tsawwassen (DFO 07590), per Guillermo: better for Steveston
    // and south of it. The Steveston gauge (07607) is closer (0.3km) but sits
    // in the river mouth and reads ~0.6m lower and ~20min later than the
    // coast (Sep 25 2026 low: 1.08m Steveston vs 1.68m Tsawwassen), so its
    // numbers don't match the tide tables riders use. Tide matters a lot
    // here: see current_note and epicSignature.
    tideStation: { code: "07590", id: "5cebf1de3d0f4a073c4bb935", name: "Tsawwassen" },
    // Sand Heads is the local go/no-go read (see liveStation below). When it
    // is already blowing from a direction that works here, trust the reading
    // over the models for this hour, and carry it a couple of hours forward.
    // On Sep 25 2026 Sand Heads was NW 18-20 by 7am while our 7:52am
    // forecast said 2kt for the same hour.
    liveReferenceTrigger: {
      name: "Sand Heads",
      thresholdKt: 12,
      offsetKt: 0,
      dirSector: [180, 350],
      persistHours: 2,
      note: "Local riders use Sand Heads as the go/no-go read for Steveston."
    },
    // The setup behind Guillermo's best ever session here, Fri Sep 25 2026
    // around 9:40am: a post frontal NW surge down the Strait (EC strong wind
    // warning, "northwest 20 to 30 this morning"; Point Atkinson pressure
    // climbing from 1004 to 1010 hPa through the day), Sand Heads NNW 21
    // gusting 26, and a falling tide (Steveston ~1.7m and dropping ~0.45m an
    // hour from a 3.2m high at 5:11am toward a 1.1m low at 11:44am), so the
    // ebb and the river outflow ran straight against the wind. Every
    // condition below has to hold for 2+ consecutive hours to flag.
    epicSignature: {
      label: "Possible epic day",
      summary: "Strong NW to NNW down the Strait with a falling tide running against it: the Sep 25 2026 setup.",
      dirSector: [295, 350],
      minKt: 17,
      tide: "falling",
      hourWindow: [7, 17],
      minHours: 2
    },
    // Swapped from the YVR airport EC station to Sand Heads — the Coast
    // Guard lightstation right at the mouth of the Fraser's South Arm, a few
    // hundred meters offshore from this spot. Per North Shore Wing Group
    // chat, local riders already use Sand Heads as their own go/no-go read
    // for Steveston ("16kts at sandheads... probably the best call"), the
    // same pattern as Pam Rocks for Porteau/Squamish — and it's a far more
    // representative reading than an airport ~15km inland. Found via
    // igetwind.com's station-finder API, same as our other igetwind
    // stations; sid inferred from Sand Heads' Environment Canada station ID
    // (CWVF) by the same "CW-" naming pattern as CWAS/CWWK/CWSB — not
    // independently confirmed against a live igetwind response this
    // session, so if it doesn't match, this live check just silently stays
    // unavailable rather than breaking anything (same defensive fallback
    // every igetwind station uses).
    liveStation: { type: "igetwind", sid: "CWVF", lat: 49.1059, lon: -123.3033, name: "Sand Heads" },
    thermal: {
      enabled: true,
      months: [4,5,6,7,8,9],
      hourWindow: [11, 19],
      dirSector: [260, 300],
      note: "Open to the Strait at the mouth of the Fraser's South Arm — picks up the same sea breeze as Jericho/Spanish Banks, but more exposed, so it also runs on general SW–W synoptic gradient wind, not just thermal."
    },
    outflow: { enabled: false },
    // Not modeled (no current data source), but worth recording — this is
    // the kind of local knowledge that explains why the same wind speed can
    // look very different here from one session to the next.
    current_note: "Strong currents here — waves can be very good when the wind opposes the current. West, NW, and SW are the best directions for this reason, independent of the general favorable-direction check above."
  },
  {
    // Coordinates and direction/tide knowledge updated (Aug 2026) directly
    // from Guillermo. The previous thermal dirSector (SW, 220-260°) is
    // dropped here — his direct knowledge says SW is actually one of the
    // *unfavorable* offshore directions at this spot (see favorable_deg
    // below), which contradicts what that config assumed, so rather than
    // carry forward a now-known-wrong thermal pattern it's left disabled
    // pending better information. The existing synoptic_note already had
    // the right idea (this spot's biggest days are gradient-driven, not
    // thermal) — tightened to name SE specifically as the core direction.
    id: "boundary-bay",
    // Swell index (rules.js swellForHours). currents: the compass direction
    // the water flows TOWARD on each tide, per Guillermo (Sep 2026): Floods north, ebbs south.
    // fetchKm: rough open water distance upwind, by the direction the wind
    // comes from (map estimates, to be tuned from rider wave reports).
    currents: { flood: 0, ebb: 180 },
    swell: { fetchKm: [[[90, 200], 15]], defaultFetchKm: 6 },
    // Tide: Tsawwassen (nearest DFO station, 7km). Rule: always the nearest DFO station,
    // except Steveston (Tsawwassen, see garry-point).
    tideStation: { code: "07590", id: "5cebf1de3d0f4a073c4bb935", name: "Tsawwassen" },
    name: "Boundary Bay (Centennial Beach)",
    region: "South Delta",
    lat: 49.008345, lon: -123.034898,
    marineZone: "strait_of_georgia_south",
    marineAnchorFactor: 0.8,
    sports: ["kite", "wingfoil", "windsurf"],
    level: "beginner-friendly",
    // SE is best; E, S and NE also work (NE tends to be cold). SW, NW and N
    // are offshore here and not recommended (also very gusty) — so the
    // favorable arc runs NE through S, explicitly excluding the SW–N range.
    favorable_deg: [[45, 180]],
    // No live station: the White Rock METAR (CWWK) read a maximum of 6kt in
    // six weeks, so it can't verify anything. Per Guillermo (Sep 2026), this
    // spot is checked by rider reports only.
    calibrationSince: "2026-09-29",
    thermal: { enabled: false },
    outflow: { enabled: false },
    synoptic_note: "Boundary Bay's biggest days are usually synoptic — a strong SE–S gradient wind ahead of an approaching frontal system funnels straight up the bay. Check the synoptic regime tag, not just the thermal one.",
    tide_note: "Minimum ~10ft tide for foil sports (winging, kitefoiling, parawinging) — no concern for kiting or windsurfing at any tide."
  },
  {
    // New spot (Aug 2026), split out from what used to be a single combined
    // "White Rock / Crescent Beach" entry — Guillermo's direct knowledge
    // makes clear these two beaches take different winds and have somewhat
    // different tide behavior, so they're now independently forecastable.
    id: "white-rock-east",
    // Swell index (rules.js swellForHours). currents: the compass direction
    // the water flows TOWARD on each tide, per Guillermo (Sep 2026): Same as Centennial: floods north, ebbs south.
    // fetchKm: rough open water distance upwind, by the direction the wind
    // comes from (map estimates, to be tuned from rider wave reports).
    currents: { flood: 0, ebb: 180 },
    swell: { fetchKm: [[[190, 280], 15], [[90, 190], 8]], defaultFetchKm: 6 },
    // Tide: White Rock (nearest DFO station, 0.7km). Rule: always the nearest DFO station,
    // except Steveston (Tsawwassen, see garry-point).
    tideStation: { code: "07577", id: "5cebf1de3d0f4a073c4bb933", name: "White Rock" },
    name: "White Rock - East Beach",
    // Water forecast point (Sep 28 2026): the beach cell is part land for
    // several models (HRDPS 2.5km read 0.59x, HRDPS West 0.69x vs a point further out, last 14 days, 8kt+ hours),
    // which reads the wind light. Same fix as Steveston.
    modelPoint: { lat: 48.995, lon: -122.81 },

    region: "South Delta",
    lat: 49.015658, lon: -122.790661,
    marineZone: "strait_of_georgia_south",
    marineAnchorFactor: 0.8,
    sports: ["kite", "wingfoil", "windsurf"],
    level: "beginner-friendly",
    // Good on E/SE/S, excellent on SW/W — one continuous arc from E through
    // W covers all of it (the engine doesn't grade "good" vs "excellent",
    // see direction_note for that texture).
    favorable_deg: [[90, 270]],
    // City of White Rock's East Beach weather station (the sensor behind
    // whiterockcity.ca's waterfront page), in knots. Replaces the White Rock
    // METAR (CWWK), which read a maximum of 6kt in six weeks. Per Guillermo.
    liveStation: { type: "whiterockcity", name: "White Rock East Beach" },
    calibrationSince: "2026-09-29",
    thermal: {
      enabled: true,
      months: [4,5,6,7,8,9],
      hourWindow: [12, 19],
      dirSector: [220, 270], // the "excellent" SW-W band specifically
      note: "Shallow bay warms fast and drives a modest SW-W afternoon sea breeze on its own, on top of whatever synoptic southerly is already blowing."
    },
    outflow: { enabled: false },
    direction_note: "Good on E, SE, or S; excellent on SW or W. Per Van Kiteboard OSR Group chat, SE specifically tends to run gustier and choppier here than a clean SW/W day, and is a more dangerous kite launch at high tide — treat \"good on SE\" as more marginal than \"excellent on SW/W,\" not equivalent. A strong NW forecast can also work here — it wraps around near 49.023707, -122.870935 and produces excellent side-shore conditions that a simple \"NW is offshore\" read would miss. Local judgment call, not modeled.",
    tide_note: "Kiting needs a tide under ~12ft — above that it's nearly impossible to launch. No problem for winging, parawinging, or windsurfing at any tide. Low tide isn't a concern either, just a longer walk to the water."
  },
  {
    // New spot (Aug 2026) — see white-rock-east above for why this was
    // split out on its own.
    id: "crescent-beach",
    // Swell index (rules.js swellForHours). currents: the compass direction
    // the water flows TOWARD on each tide, per Guillermo (Sep 2026): Same as Centennial: floods north, ebbs south.
    // fetchKm: rough open water distance upwind, by the direction the wind
    // comes from (map estimates, to be tuned from rider wave reports).
    currents: { flood: 0, ebb: 180 },
    swell: { fetchKm: [[[210, 280], 12]], defaultFetchKm: 5 },
    // Tide: Crescent Beach (nearest DFO station, 2.7km). Rule: always the nearest DFO station,
    // except Steveston (Tsawwassen, see garry-point).
    tideStation: { code: "07579", id: "5dd3064fe0fdc4b9b4be69d7", name: "Crescent Beach" },
    name: "Crescent Beach",
    // Water forecast point (Sep 28 2026): the beach cell is part land for
    // several models (HRRR read 0.49x, NBM 0.72x vs a point further out, last 14 days, 8kt+ hours),
    // which reads the wind light. Same fix as Steveston.
    modelPoint: { lat: 49.03, lon: -122.95 },

    region: "South Delta",
    lat: 49.057512, lon: -122.888188,
    marineZone: "strait_of_georgia_south",
    marineAnchorFactor: 0.8,
    sports: ["kite", "wingfoil", "windsurf"],
    level: "beginner-friendly",
    // Same wind pattern as Tsawwassen Ferry Terminal per local knowledge: W
    // best when strong, SW also works well, N can work as long as it doesn't
    // carry much East in it (i.e. due N, not NE).
    favorable_deg: [[210, 280], [345, 10]],
    // City of White Rock's East Beach weather station (the sensor behind
    // whiterockcity.ca's waterfront page), in knots. Replaces the White Rock
    // METAR (CWWK), which read a maximum of 6kt in six weeks. Per Guillermo, also the
    // best nearby reading for Crescent Beach (~7km).
    liveStation: { type: "whiterockcity", name: "White Rock East Beach" },
    calibrationSince: "2026-09-29",
    // No confirmed thermal timing/season pattern from local knowledge yet —
    // left disabled rather than assume it matches its South Delta
    // neighbors, same reasoning as Erwin Park's thermal field.
    thermal: { enabled: false },
    outflow: { enabled: false },
    direction_note: "West is best when strong; SW also works very well. North can work too, as long as it doesn't have much East in it (due N, not NE).",
    tide_note: "Same tide concern as White Rock East Beach — kiting needs a tide under ~12ft; no problem for winging, parawinging, or windsurfing at any tide."
  },
  {
    // New spot (Aug 2026). Only the south side of the causeway is modeled —
    // per Guillermo, the north side has the opposite behavior (flat when
    // the south side has waves and vice versa) and a higher tide minimum
    // (12ft+ vs 8ft+ if foiling); he chose to model just the south side for
    // now rather than add a second "north causeway" entry with the inverse
    // rules. Revisit if the north side turns out to be worth its own spot.
    id: "tsawwassen-south",
    // Swell index (rules.js swellForHours). currents: the compass direction
    // the water flows TOWARD on each tide, per Guillermo (Sep 2026): Same as Centennial: floods north, ebbs south. NW and N are flat water on this side of the causeway.
    // fetchKm: rough open water distance upwind, by the direction the wind
    // comes from (map estimates, to be tuned from rider wave reports).
    currents: { flood: 0, ebb: 180 },
    swell: { fetchKm: [[[160, 240], 25], [[300, 20], 2]], defaultFetchKm: 8 },
    // Tide: Tsawwassen (nearest DFO station, 1.4km). Rule: always the nearest DFO station,
    // except Steveston (Tsawwassen, see garry-point).
    tideStation: { code: "07590", id: "5cebf1de3d0f4a073c4bb935", name: "Tsawwassen" },
    name: "Tsawwassen Ferry Terminal Causeway",
    // Water forecast point (Sep 28 2026): the beach cell is part land for
    // several models (ECMWF read 0.42x, HRRR 0.57x, NBM 0.62x; the learned forecast already uses its own point, this is for the rest vs a point further out, last 14 days, 8kt+ hours),
    // which reads the wind light. Same fix as Steveston.
    modelPoint: { lat: 48.99, lon: -123.16 },

    region: "South Delta",
    lat: 49.015191, lon: -123.114600,
    marineZone: "strait_of_georgia_south",
    marineAnchorFactor: 0.9,
    sports: ["kite", "wingfoil", "windsurf"],
    // Advanced, per Guillermo (Oct 2026): even when it's onshore, the
    // consequences for a beginner are high if things go wrong, kiting most.
    level: "advanced",
    // The causeway runs east to west and is ridden on both sides (Guillermo,
    // Oct 2026). South side (the usual one): S and SW are onshore and can be
    // great; SE works but is gusty; W is side shore on both sides; NW and N
    // are offshore on the south side, advanced only. North side: the mirror
    // image (NNW is onshore), but it needs 10ft+ of tide (dries below that)
    // and there's little room to launch a kite, so it's rarely used.
    // Something works from SE round through W to N, so all of that is
    // favorable; `sides` below says which side, hour by hour (index.html
    // sideVerdict, sideLineForDay and the hour popup). First match wins.
    favorable_deg: [[120, 30]],
    sides: {
      sectors: [
        { dir: [120, 150], key: "se", text: "SE: works on the south side, but gusty" },
        { dir: [151, 260], key: "south", text: "South side onshore" },
        { dir: [261, 284], key: "west", text: "West: side shore on both sides" },
        { dir: [285, 30], key: "off", text: "South side offshore, advanced only", northOnshore: true },
      ],
      northMinTideFt: 10,
      otherText: "Wind along the causeway, not a usual direction here",
    },
    caution_note: "Advanced riders only: high consequences if things go wrong, especially kiting.",
    // EC's Tsawwassen Ferry Terminal station, right at the causeway, per
    // Guillermo (Sep 2026). Replaces the White Rock METAR, 19km away.
    liveStation: { code: "vtf", name: "Tsawwassen Ferry Terminal" },
    calibrationSince: "2026-09-29",
    // Learned correction (rules.js applyMos, data/mos-coefficients.json):
    // fitted on a year of Ferry Terminal hourly readings vs the day before models.
    // The spot is next to the station, so no offset.
    mos: { point: "tsaw", offsetKt: 0 },
    thermal: { enabled: false },
    outflow: { enabled: false },
    direction_note: "The causeway runs east to west and can be ridden on both sides. South side (most common): S and SW are onshore and can be great; SE works but is gusty; W is side shore on both sides; N and NW are offshore there, advanced riders only. North side: the opposite, so NNW is onshore; rarely used.",
    tide_note: "South side isn't foilable below about 8ft of tide. North side needs at least 10ft (it dries below that) and has little room to launch a kite."
  },
  {
    // Corrected location (was a placeholder guess at Point Roberts, ~45km
    // south of here) — confirmed by the site owner to be right next to
    // Point Atkinson in West Vancouver, a couple km away. Not the same
    // exposure as Point Atkinson itself: Erwin Park is the actual water
    // access point (wingfoil/windsurf always, kite only on a very low
    // tide), and per local rider knowledge it typically reads about 4-5kt
    // lighter than Point Atkinson and favors an East-to-Southeast wind —
    // not the SW sea breeze this config wrongly assumed before the
    // location was corrected. Coordinates refined again (Aug 2026) to
    // Guillermo's exact water-access point.
    id: "erwin-park",
    // Swell index (rules.js swellForHours). currents: the compass direction
    // the water flows TOWARD on each tide, per Guillermo (Sep 2026): Same as Jericho: floods east, ebbs west.
    // fetchKm: rough open water distance upwind, by the direction the wind
    // comes from (map estimates, to be tuned from rider wave reports).
    currents: { flood: 90, ebb: 270 },
    swell: { fetchKm: [[[90, 150], 8], [[240, 300], 30]], defaultFetchKm: 6 },
    // Tide: Sandy Cove (nearest DFO station, 0.6km; same as Point Atkinson within ~0.05m). Rule: always the nearest DFO station,
    // except Steveston (Tsawwassen, see garry-point).
    tideStation: { code: "07786", id: "5cebf1e43d0f4a073c4bc43b", name: "Sandy Cove" },
    name: "Erwin Park",
    region: "West Vancouver",
    lat: 49.338035, lon: -123.238878,
    sports: ["windsurf", "wingfoil", "kite"],
    level: "intermediate",
    // East through just past Southeast is the primary, locally-confirmed
    // pattern (and the only sector the Point Atkinson offset relationship
    // below is validated for). A second sector added from a chat data point
    // (Chris, 2025-10-11: "Erwin 22 knots. West. Heading") — a due-W wind is
    // also a real go-signal here, confirmed by Guillermo, but kept separate
    // and narrow since it's a single data point rather than a season of
    // knowledge like the ESE pattern. Only affects the general favorable-
    // direction flag, not the Point Atkinson offset estimate (referenceStation
    // below), which still only applies within the ESE dirSector.
    favorable_deg: [[90, 140], [260, 280]],
    // Point Atkinson's own live SWOB station — found via igetwind.com's
    // station-finder API, same pattern as Pam Rocks/White Rock (see README
    // "Live verification"). Far more relevant now that Erwin Park is
    // confirmed to be right next to Point Atkinson, rather than sharing the
    // White Rock METAR ~45km away. Not independently confirmed that
    // igetwind's aggregator carries this specific station id — if it
    // doesn't, this live check just silently stays unavailable rather than
    // breaking anything (same defensive fallback every igetwind station
    // uses).
    liveStation: { type: "igetwind", sid: "CWSB", lat: 49.3300, lon: -123.2650, name: "Point Atkinson" },
    // Learned correction (rules.js applyMos, data/mos-coefficients.json):
    // fitted on a year of Point Atkinson hourly readings vs the day before models.
    // It forecasts Point Atkinson itself, so the riders' rule applies on top:
    // Erwin runs about 4.5kt lighter (Point Atkinson 19kt+ = Erwin ~14.5kt).
    mos: { point: "erwin", offsetKt: -4.5 },
    calibrationSince: "2026-09-28",
    // Erwin sits right at the mouth of Howe Sound but faces east, so the
    // Strait of Georgia zone (which is what actually drives its E/SE days) is
    // the right marine bulletin to anchor against, not Howe Sound.
    marineZone: "strait_of_georgia_south",
    // Left at the default 1.0 (no scale-down) deliberately. Erwin's -4.5kt
    // offset is relative to POINT ATKINSON — a headland that reads high — not
    // relative to the open-water zone forecast, so the two shouldn't be
    // stacked. Evidence from the Aug 26 2026 morning: EC called southeast
    // 10-15kt for the zone and riders here were on 4m/5m gear, i.e. Erwin was
    // running at or above EC's range, not below it.
    marineAnchorFactor: 1.0,
    // No local-knowledge basis for a thermal (sea-breeze) driver here,
    // unlike the SW-facing spots further south — left disabled rather than
    // guess at one. If Erwin Park does have a thermal component to its
    // East/Southeast wind, let us know and this can be modeled properly.
    thermal: { enabled: false },
    // Erwin's signature wind is an easterly, and a good share of its sessions
    // are early-morning offshore-drainage days — chat history is emphatic:
    // "PA wind meter is being influenced by the out flow. Erwin OSR, ESE,
    // 15-20kts" (Luke Penner), "Hoping for easterly tomorrow morning at Erwin
    // 20-30", "Easterly at Erwin", and Erwin chatter peaks hard at 6-9am
    // (37% of all mentions fall in the 5-9am window, peaking at 7am) with
    // "dawn patrol at Erwin" a recurring phrase. This was previously left
    // disabled, which made the drainage regime literally unreachable for the
    // one spot whose signature wind it is.
    outflow: {
      enabled: true,
      dirSector: [70, 150], // ENE through SE — the offshore drainage arc here
      note: "Offshore drainage/outflow easterly at the mouth of Howe Sound — typically an early-morning event that fades as the day heats up, which is why so many sessions here are dawn patrols. Coarse global models under-resolve shallow drainage flow over this shoreline, so treat a light model reading with suspicion on a clear, cold morning."
    },
    // Same drainage arc as the outflow sector — an easterly here is rideable,
    // not offshore-and-dangerous, because the beach faces into it.
    outflow_favorable_deg: [[70, 150]],
    // Local rider rule of thumb: Erwin Park typically reads about 4-5kt
    // lighter than Point Atkinson (its own reference point, ~2km away) when
    // the wind is East-to-Southeast — an offset relationship, not just a
    // "did it cross a threshold" trigger. `offsetKt` is added to Point
    // Atkinson's reading to estimate this spot's speed; `dirSector` gates
    // it to the direction this actually holds for. See classifyHour() in
    // rules.js for how offsetKt is used differently from a plain
    // thresholdKt-only referenceStation (e.g. Erwin Park's old config, or
    // a future spot that only needs the simpler "did it cross X" check).
    referenceStation: {
      name: "Point Atkinson",
      lat: 49.3300, lon: -123.2650,
      offsetKt: -4.5,
      dirSector: [90, 140],
      note: "Point Atkinson is right next to Erwin Park, and typically reads a bit stronger than what you'll actually get at the water access here."
    },
    // The live counterpart to referenceStation above, and the one that matches
    // how riders actually decide. Threshold comes from four independent chat
    // reports converging on ~19-21kt on the live Point Atkinson meter:
    // "Point Atkinson 21kts now, will head to Erwin if it holds" (Luke),
    // "Head to Erwin once it hits 20 knots", "Erwin must be on. Point Atkinson
    // is 23kts", "Will try Erwin later. Once it stays above 19 knots" (Julia).
    // No dirSector: riders quote the PA number regardless of direction, and
    // the reports above span both the easterly-drainage and westerly days.
    // Only ever applies to the current hour — see classifyHour.
    liveReferenceTrigger: {
      name: "Point Atkinson",
      thresholdKt: 19,
      offsetKt: -4.5,
      note: "This is the same call local riders make off the live Point Atkinson meter."
    },
    tide_note: "Tides aren't a concern for wing/foil/windsurf here, but kites can only be launched at low tide — this is a very small beach access."
  },
  {
    // New spot (Aug 2026), added directly by Guillermo alongside the
    // Ambleside refinement below — the two are "almost identical" per his
    // description, sharing the same tide/wind mechanic (see current_note).
    id: "dundarave-pier",
    // Swell index (rules.js swellForHours). currents: the compass direction
    // the water flows TOWARD on each tide, per Guillermo (Sep 2026): Same as Jericho: floods east, ebbs west, so the big waves come on the ebb with a NW or W wind.
    // fetchKm: rough open water distance upwind, by the direction the wind
    // comes from (map estimates, to be tuned from rider wave reports).
    currents: { flood: 90, ebb: 270 },
    swell: { fetchKm: [[[230, 320], 30]], defaultFetchKm: 6 },
    // Tide: Ambleside (nearest DFO station, 2.2km; same as Point Atkinson within ~0.05m). Rule: always the nearest DFO station,
    // except Steveston (Tsawwassen, see garry-point).
    tideStation: { code: "07780", id: "5cebf1e43d0f4a073c4bc45a", name: "Ambleside" },
    name: "Dundarave Pier Beach",
    region: "West Vancouver",
    lat: 49.332129, lon: -123.183767,
    marineZone: "strait_of_georgia_south",
    marineAnchorFactor: 0.8,
    sports: ["windsurf", "wingfoil", "kite"],
    level: "intermediate",
    // Same westerly sector as Ambleside next door — see direction_note for
    // the W-vs-NW nuance neither favorable_deg nor the engine's binary
    // favorable check can represent on its own.
    favorable_deg: [[230, 320]],
    // No dedicated nearby station — reusing Ambleside's Vancouver Harbour EC
    // station, ~2km away, the closest official reading available.
    liveStation: { code: "whc", name: "Vancouver Harbour" },
    thermal: { enabled: false },
    outflow: { enabled: false },
    current_note: "Big waves here when the tide in the channel is going out (ebb) combined with a NW or West wind — the wind opposing the outgoing current is what makes it work, the same mechanic as Steveston/Garry Point. NW and W are the best directions for this reason. Not modeled (no current data source), but worth applying manually.",
    direction_note: "The more west in the wind, the better — a wind with a lot of north in it works less well here (see Ambleside Beach, which behaves almost identically; on a given day one spot can work better than the other).",
    access_note: "Popular spot, often crowded — that makes kite launches difficult here (a people problem, not a tide/wind one). Wing, foil, and windsurf launches aren't affected."
  },
  {
    // Added from North Shore Wing Group chat history rather than a direct
    // rider conversation initially — coordinates and the fuller tide/current
    // picture since confirmed directly by Guillermo (Aug 2026), who
    // describes this spot as "almost identical" to Dundarave Pier Beach
    // above (same ebb-tide + NW/W wave mechanic). The group's own mention
    // ("Ambleside is on! 5.5, decent well") and Michael Thomas's original
    // tide rule of thumb still stand as the earliest source for this spot,
    // but there's still no season of direct local knowledge behind the
    // thermal/direction config the way there is for e.g. Squamish or Erwin
    // Park. Flag if this needs correcting.
    id: "ambleside",
    // Swell index (rules.js swellForHours). currents: the compass direction
    // the water flows TOWARD on each tide, per Guillermo (Sep 2026): Same as Jericho: floods east, ebbs west; the last hour or two of the ebb with a west wind gives a good rip.
    // fetchKm: rough open water distance upwind, by the direction the wind
    // comes from (map estimates, to be tuned from rider wave reports).
    currents: { flood: 90, ebb: 270 },
    swell: { fetchKm: [[[230, 320], 30]], defaultFetchKm: 6 },
    // Tide: Ambleside (nearest DFO station, 0.4km; same as Point Atkinson within ~0.05m). Rule: always the nearest DFO station,
    // except Steveston (Tsawwassen, see garry-point).
    tideStation: { code: "07780", id: "5cebf1e43d0f4a073c4bc45a", name: "Ambleside" },
    name: "Ambleside Beach",
    region: "West Vancouver",
    lat: 49.322244, lon: -123.151668,
    marineZone: "strait_of_georgia_south",
    marineAnchorFactor: 0.8,
    sports: ["windsurf", "wingfoil"],
    level: "intermediate",
    // Port rules (Boaters' Handbook, Oct 2026): non motorized craft,
    // including sailboats and boards, are prohibited in the First Narrows
    // traffic control zone (TCZ-1), which starts just off Ambleside: its
    // west edge runs from the Lions Gate Bridge north pier through Capilano
    // light to a line north from Ferguson Point.
    caution_note: "Port rules: no sail, kite, wing or paddle craft in the First Narrows shipping zone, which starts just off Ambleside toward the Lions Gate Bridge and the channel. Stay west and close to shore.",
    // Right at the entrance to Burrard Inlet / First Narrows — same general
    // English Bay opening as Jericho/Spanish Banks, so provisionally given
    // the same westerly favorable sector rather than guessing a new one.
    favorable_deg: [[230, 320]],
    // Vancouver Harbour EC station — already used for Jericho/Spanish Banks
    // and Dundarave Pier Beach next door, and if anything more directly
    // representative here since Ambleside sits right at the harbour mouth.
    liveStation: { code: "whc", name: "Vancouver Harbour" },
    // No confirmed thermal pattern from local knowledge yet — left disabled
    // rather than assume it shares Jericho's sea-breeze timing just because
    // it's nearby. The tide/current rule the group and Guillermo both gave
    // isn't something our thermal/outflow/synoptic model represents (this
    // app doesn't factor in tide state at all yet — see README known
    // limitations), so it's captured here as a note for a rider to apply
    // manually rather than built into classifyHour.
    thermal: { enabled: false },
    outflow: { enabled: false },
    current_note: "Big waves here when the tide in the channel is going out (ebb) combined with a NW or West wind — same mechanic as Dundarave Pier Beach next door. Per local rider knowledge (Michael Thomas, North Shore Wing Group): the last hour or two of falling tide before slack, still with a west wind, produces a notably good rip. Not modeled (this app doesn't track tide state yet); factor in manually against a tide table.",
    direction_note: "The more west in the wind, the better — a wind with a lot of north in it works less well. Almost identical to Dundarave Pier Beach nearby; on a given day one spot can work better than the other."
  },
  {
    // New spot (Oct 2026), requested by Ivan Dianov in the group chat for
    // wing foil and windsurf. Coordinates are the Cates Park boat ramp
    // (OpenStreetMap slipway node), on the north shore of Burrard Inlet
    // just west of the Indian Arm entrance.
    id: "cates-park",
    // Swell index (rules.js swellForHours). currents: the compass direction
    // the water flows TOWARD on each tide, per Guillermo (Oct 2026): floods
    // east, ebbs west, so a west wind against the ebb stands the water up.
    // fetchKm: rough open water distance upwind (map estimates, to be tuned
    // from rider wave reports): about 6km down the inlet toward Second
    // Narrows on a west wind, about 4km toward Belcarra and the Port Moody
    // arm on E or SE, and only the 1.5 to 2km across to Burnaby otherwise.
    currents: { flood: 90, ebb: 270 },
    swell: { fetchKm: [[[245, 280], 6], [[90, 150], 4]], defaultFetchKm: 2 },
    // Tide: Deep Cove (nearest DFO station with predictions, 3.0km; Second
    // Narrows has none). Rule: always the nearest DFO station, except
    // Steveston (Tsawwassen, see garry-point).
    tideStation: { code: "07765", id: "5dd3064ee0fdc4b9b4be6707", name: "Deep Cove" },
    name: "Cates Park Boat Launch",
    region: "North Vancouver",
    lat: 49.30166, lon: -122.95910,
    // No modelPoint: the inlet is narrow and every fine model put the ramp
    // and mid channel in the same cell (ratio 1.00 over the last 14 days).
    // The inlet does run about half the speed of the open strait off
    // Jericho in the same models, which is real shelter, not a land cell.
    // No marineZone either: the EC Strait of Georgia forecast doesn't
    // describe the wind this far up Burrard Inlet.
    sports: ["wingfoil", "windsurf"],
    level: "intermediate",
    // Port rules (Boaters' Handbook, Oct 2026): non motorized craft are
    // prohibited in the Second Narrows traffic control zone (TCZ-2), whose
    // east edge is a line north from Berry Point, about 2km west of the
    // ramp. A 5 knot limit applies within 150m of shore from Little Cates
    // Park to 250m west of the boat launch.
    caution_note: "Port rules: no sail, kite, wing or paddle craft in the Second Narrows shipping zone, which starts about 2km west of the ramp (a line north from Berry Point), so don't ride west toward the bridges. 5 knot limit within 150m of shore around the park and launch: get out past 150m before you get up on the foil.",
    // Per Guillermo: West mostly, and South West; East or SE can work too.
    // Anything with north in it is offshore here, so the arc stops at W
    // (280 leaves room for model direction rounding) and starts at E.
    favorable_deg: [[90, 280]],
    // No live station: the closest one, VA7IS in North Vancouver, read near
    // zero while the models had a 10 to 13kt westerly, so it isn't trusted.
    thermal: { enabled: false },
    outflow: { enabled: false },
    direction_note: "Best on W and SW. E and SE can work too. Any wind with north in it (NW, N, NE) is offshore here, so skip it.",
    current_note: "Floods east, ebbs west. A west wind against the ebb gives the most chop.",
    access_note: "Small local spot. Launch from the Cates Park boat ramp; share it with boat traffic."
  }
];

// Webcams shown under "Live surface conditions around the region"
// (index.html renderWebcams), per Guillermo (Oct 2026). `image` is the
// camera's own latest snapshot, loaded straight from the owner's server
// (nothing is copied into this repo) and refreshed while the page is open;
// the card links to the owner's page. Cameras without a public snapshot
// (the Sea to Sky Gondola embeds its picture inside its own page and blocks
// other sites) get a link card only.
// White Rock's cameras stream to YouTube through CamStreamer, the embed the
// city uses on its own page. The picture is YouTube's live thumbnail for
// the stream. The YouTube id changes when a stream restarts, so each
// forecast run follows the CamStreamer embed to the current id
// (generate.mjs resolveWebcams, forecast.json `webcams`); `youtube` here is
// only the fallback.
// To add one: id, name, area, camera page url, optional snapshot image url
// or camstreamer embed id, optional credit and spot id it looks at.
export const WEBCAMS = [
  { id: "jericho", name: "Jericho Sailing Centre streamcam", area: "Jericho and English Bay", url: "https://jsca.bc.ca/services/steamcam-ptz/", image: "https://streamer5.brownrice.com/cam-images/jscaptz.jpg", credit: "Jericho Sailing Centre", spotId: "jericho-spanish-banks" },
  { id: "whiterock-east", name: "White Rock East Beach camera", area: "White Rock East Beach", url: "https://www.whiterockcity.ca/1212/Waterfront-Live-Cameras", camstreamer: "Sev2OTrlNL6v43zBHBp0DuE9tobufzZI1zXUkAdW", youtube: "ClvJjIz5GE4", credit: "City of White Rock", spotId: "white-rock-east" },
  { id: "whiterock-west", name: "White Rock West Beach (pier) camera", area: "White Rock West Beach and the pier", url: "https://www.whiterockcity.ca/1212/Waterfront-Live-Cameras", camstreamer: "kJLUClW1kDbLu1C1N8WKsKXGxWcK0gI26OvLxcc2", youtube: "4MK3E9EWDSY", credit: "City of White Rock" },
  { id: "gondola", name: "Sea to Sky Gondola", area: "Squamish and Howe Sound", url: "https://www.seatoskygondola.com/weather-and-cams/", spotId: "squamish-spit" },
];

export const DEG_LABELS = ["N","NNE","NE","ENE","E","ESE","SE","SSE","S","SSW","SW","WSW","W","WNW","NW","NNW"];

export function degToLabel(deg) {
  if (deg === null || deg === undefined || isNaN(deg)) return "—";
  const ix = Math.round(((deg % 360) / 22.5)) % 16;
  return DEG_LABELS[ix];
}

export function inSector(deg, sector) {
  if (deg === null || deg === undefined || isNaN(deg)) return false;
  const [a, b] = sector;
  if (a <= b) return deg >= a && deg <= b;
  return deg >= a || deg <= b; // wraps through 360/0
}
