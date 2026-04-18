import type { TrainLine, Connection } from '@/types'

export const LINES: TrainLine[] = [
  {
    id: 'jr_yamanote',
    name: 'JR山手線',
    operator: 'JR東日本',
    color: '#80C241',
    stations: [
      'shinagawa', 'osaki', 'gotanda', 'meguro', 'ebisu', 'shibuya',
      'harajuku', 'yoyogi', 'shinjuku', 'shin_okubo', 'takadanobaba',
      'mejiro', 'ikebukuro', 'otsuka', 'sugamo', 'komagome', 'tabata',
      'nishi_nippori', 'nippori', 'uguisudani', 'ueno', 'okachimachi',
      'akihabara', 'kanda', 'tokyo', 'yurakucho', 'shimbashi',
      'hamamatsucho', 'tamachi',
    ],
  },
  {
    id: 'jr_chuo',
    name: 'JR中央線',
    operator: 'JR東日本',
    color: '#F15A22',
    stations: [
      'tokyo', 'kanda', 'ochanomizu', 'yotsuya', 'shinjuku',
      'nakano', 'koenji', 'asagaya', 'ogikubo', 'nishi_ogikubo',
      'kichijoji', 'mitaka', 'musashisakai', 'higashi_koganei',
      'musashi_koganei', 'kokubunji', 'kunitachi', 'tachikawa',
    ],
  },
  {
    id: 'jr_keihin_tohoku',
    name: 'JR京浜東北線',
    operator: 'JR東日本',
    color: '#00B2E5',
    stations: [
      'omiya', 'saitama_shintoshin', 'yono', 'kita_urawa', 'urawa',
      'minami_urawa', 'warabi', 'nishi_kawaguchi', 'kawaguchi',
      'akabane', 'higashi_jujo', 'oji', 'kamiya', 'tabata',
      'nishi_nippori', 'nippori', 'uguisudani', 'ueno', 'okachimachi',
      'akihabara', 'kanda', 'tokyo', 'yurakucho', 'shimbashi',
      'hamamatsucho', 'tamachi', 'shinagawa', 'oimachi', 'omori',
      'kamata', 'keihin_kawasaki',
    ],
  },
  {
    id: 'metro_marunouchi',
    name: '東京メトロ丸ノ内線',
    operator: '東京メトロ',
    color: '#E60012',
    stations: [
      'ikebukuro', 'shin_otsuka', 'myogadani', 'korakuen',
      'hongo_sanchome', 'ochanomizu', 'awajicho', 'otemachi',
      'tokyo', 'ginza', 'kasumigaseki', 'kokkaigijido_mae',
      'akasaka_mitsuke', 'yotsuya', 'yotsuya_sanchome',
      'shinjuku_gyoenmae', 'shinjuku_sanchome', 'shinjuku',
      'nishi_shinjuku', 'nakanosakaue', 'nakano_shimbashi',
      'nakano_fujimisho', 'honancho',
    ],
  },
  {
    id: 'metro_ginza',
    name: '東京メトロ銀座線',
    operator: '東京メトロ',
    color: '#FF9500',
    stations: [
      'shibuya', 'omotesando', 'gaienmae', 'aoyama_itchome',
      'akasaka_mitsuke', 'tameike_sanno', 'toranomon', 'shimbashi',
      'ginza', 'kyobashi', 'nihombashi', 'mitsukoshimae',
      'kanda', 'suehirocho', 'ueno_hirokoji', 'ueno',
      'inaricho', 'tawaramachi', 'asakusa',
    ],
  },
  {
    id: 'metro_hibiya',
    name: '東京メトロ日比谷線',
    operator: '東京メトロ',
    color: '#9CAEB7',
    stations: [
      'nakameguro', 'ebisu', 'hiroo', 'roppongi', 'kamiyacho',
      'kasumigaseki', 'hibiya', 'ginza', 'higashi_ginza', 'tsukiji',
      'hatchobori', 'kayabacho', 'ningyocho', 'kodenmacho',
      'akihabara', 'naka_okachimachi', 'ueno',
      'minamisenju', 'kitasenju',
    ],
  },
  {
    id: 'metro_tozai',
    name: '東京メトロ東西線',
    operator: '東京メトロ',
    color: '#009BBF',
    stations: [
      'nakano', 'ochiai', 'takadanobaba', 'waseda', 'kagurazaka',
      'iidabashi', 'kudanshita', 'takebashi', 'otemachi',
      'nihombashi', 'kayabacho', 'monzen_nakacho', 'kiba',
      'tatsumi', 'minamisuna', 'nishi_kasai', 'kasai',
    ],
  },
]

export const LINE_MAP = new Map(LINES.map(l => [l.id, l]))

// Inter-station distances in km
const DISTANCES: Record<string, Record<string, number>> = {
  // JR山手線
  shinagawa: { osaki: 2.0, tamachi: 1.6 },
  osaki: { shinagawa: 2.0, gotanda: 1.1 },
  gotanda: { osaki: 1.1, meguro: 0.9 },
  meguro: { gotanda: 0.9, ebisu: 1.1 },
  ebisu: { meguro: 1.1, shibuya: 1.1, nakameguro: 1.4 },
  shibuya: { ebisu: 1.1, harajuku: 1.4, omotesando: 1.3 },
  harajuku: { shibuya: 1.4, yoyogi: 0.7 },
  yoyogi: { harajuku: 0.7, shinjuku: 1.0 },
  shinjuku: { yoyogi: 1.0, shin_okubo: 0.9, nakano: 4.2, nishi_shinjuku: 0.7, shinjuku_sanchome: 0.6 },
  shin_okubo: { shinjuku: 0.9, takadanobaba: 1.1 },
  takadanobaba: { shin_okubo: 1.1, mejiro: 1.0, ochiai: 1.7, nakano: 3.3 },
  mejiro: { takadanobaba: 1.0, ikebukuro: 1.2 },
  ikebukuro: { mejiro: 1.2, otsuka: 1.3, shin_otsuka: 0.9 },
  otsuka: { ikebukuro: 1.3, sugamo: 1.1 },
  sugamo: { otsuka: 1.1, komagome: 1.1 },
  komagome: { sugamo: 1.1, tabata: 1.1 },
  tabata: { komagome: 1.1, nishi_nippori: 0.9 },
  nishi_nippori: { tabata: 0.9, nippori: 0.5 },
  nippori: { nishi_nippori: 0.5, uguisudani: 0.7 },
  uguisudani: { nippori: 0.7, ueno: 0.6 },
  ueno: { uguisudani: 0.6, okachimachi: 0.5, ueno_hirokoji: 0.3, naka_okachimachi: 0.6, minamisenju: 1.4 },
  okachimachi: { ueno: 0.5, akihabara: 0.6 },
  akihabara: { okachimachi: 0.6, kanda: 0.7, kodenmacho: 0.9 },
  kanda: { akihabara: 0.7, tokyo: 1.3, mitsukoshimae: 1.0, suehirocho: 0.9 },
  tokyo: { kanda: 1.3, yurakucho: 0.8, otemachi: 0.7, ginza: 1.1 },
  yurakucho: { tokyo: 0.8, shimbashi: 0.7, hibiya: 0.8 },
  shimbashi: { yurakucho: 0.7, hamamatsucho: 0.9, ginza: 0.7, toranomon: 0.9 },
  hamamatsucho: { shimbashi: 0.9, tamachi: 1.1 },
  tamachi: { hamamatsucho: 1.1, shinagawa: 1.6 },
  // JR中央線
  ochanomizu: { kanda: 1.2, yotsuya: 3.5, hongo_sanchome: 0.7, awajicho: 0.4 },
  yotsuya: { ochanomizu: 3.5, shinjuku: 3.3, akasaka_mitsuke: 1.5, yotsuya_sanchome: 0.9 },
  nakano: { shinjuku: 4.2, koenji: 1.8, ochiai: 1.5, nakanosakaue: 1.2 },
  koenji: { nakano: 1.8, asagaya: 1.1 },
  asagaya: { koenji: 1.1, ogikubo: 1.5 },
  ogikubo: { asagaya: 1.5, nishi_ogikubo: 1.5 },
  nishi_ogikubo: { ogikubo: 1.5, kichijoji: 2.3 },
  kichijoji: { nishi_ogikubo: 2.3, mitaka: 2.3 },
  mitaka: { kichijoji: 2.3, musashisakai: 1.4 },
  musashisakai: { mitaka: 1.4, higashi_koganei: 1.3 },
  higashi_koganei: { musashisakai: 1.3, musashi_koganei: 1.7 },
  musashi_koganei: { higashi_koganei: 1.7, kokubunji: 2.3 },
  kokubunji: { musashi_koganei: 2.3, kunitachi: 3.2 },
  kunitachi: { kokubunji: 3.2, tachikawa: 3.2 },
  tachikawa: { kunitachi: 3.2 },
  // 丸ノ内線
  shin_otsuka: { ikebukuro: 0.9, myogadani: 0.9 },
  myogadani: { shin_otsuka: 0.9, korakuen: 2.0 },
  korakuen: { myogadani: 2.0, hongo_sanchome: 0.9 },
  hongo_sanchome: { korakuen: 0.9, ochanomizu: 0.7 },
  awajicho: { ochanomizu: 0.4, otemachi: 1.2 },
  otemachi: { awajicho: 1.2, tokyo: 0.7, nihombashi: 0.8, takebashi: 0.9 },
  ginza: { tokyo: 1.1, kasumigaseki: 1.4, shimbashi: 0.7, higashi_ginza: 0.5 },
  kasumigaseki: { ginza: 1.4, kokkaigijido_mae: 0.7, hibiya: 0.8, kamiyacho: 1.4 },
  kokkaigijido_mae: { kasumigaseki: 0.7, akasaka_mitsuke: 1.1 },
  akasaka_mitsuke: { kokkaigijido_mae: 1.1, yotsuya: 1.5, tameike_sanno: 0.7 },
  yotsuya_sanchome: { yotsuya: 0.9, shinjuku_gyoenmae: 0.7 },
  shinjuku_gyoenmae: { yotsuya_sanchome: 0.7, shinjuku_sanchome: 0.8 },
  shinjuku_sanchome: { shinjuku_gyoenmae: 0.8, shinjuku: 0.6 },
  nishi_shinjuku: { shinjuku: 0.7, nakanosakaue: 1.2 },
  nakanosakaue: { nishi_shinjuku: 1.2, nakano: 1.2, nakano_shimbashi: 0.9 },
  nakano_shimbashi: { nakanosakaue: 0.9, nakano_fujimisho: 0.8 },
  nakano_fujimisho: { nakano_shimbashi: 0.8, honancho: 1.2 },
  honancho: { nakano_fujimisho: 1.2 },
  // 銀座線
  omotesando: { shibuya: 1.3, gaienmae: 0.6 },
  gaienmae: { omotesando: 0.6, aoyama_itchome: 0.7 },
  aoyama_itchome: { gaienmae: 0.7, akasaka_mitsuke: 1.4 },
  tameike_sanno: { akasaka_mitsuke: 0.7, toranomon: 0.8 },
  toranomon: { tameike_sanno: 0.8, shimbashi: 0.9 },
  kyobashi: { ginza: 0.7, nihombashi: 0.7 },
  nihombashi: { kyobashi: 0.7, mitsukoshimae: 0.4, kayabacho: 0.5 },
  mitsukoshimae: { nihombashi: 0.4, kanda: 1.0 },
  suehirocho: { kanda: 0.9, ueno_hirokoji: 0.4 },
  ueno_hirokoji: { suehirocho: 0.4, ueno: 0.3 },
  inaricho: { ueno: 0.8, tawaramachi: 0.9 },
  tawaramachi: { inaricho: 0.9, asakusa: 0.5 },
  asakusa: { tawaramachi: 0.5 },
  // 日比谷線
  nakameguro: { ebisu: 1.4 },
  hiroo: { ebisu: 1.0, roppongi: 1.5 },
  roppongi: { hiroo: 1.5, kamiyacho: 1.5 },
  kamiyacho: { roppongi: 1.5, kasumigaseki: 1.4 },
  hibiya: { kasumigaseki: 0.8, yurakucho: 0.8, ginza: 0.7 },
  higashi_ginza: { ginza: 0.5, tsukiji: 0.7 },
  tsukiji: { higashi_ginza: 0.7, hatchobori: 0.9 },
  hatchobori: { tsukiji: 0.9, kayabacho: 0.7 },
  kayabacho: { hatchobori: 0.7, ningyocho: 0.8, nihombashi: 0.5 },
  ningyocho: { kayabacho: 0.8, kodenmacho: 0.5 },
  kodenmacho: { ningyocho: 0.5, akihabara: 0.9 },
  naka_okachimachi: { akihabara: 0.5, ueno: 0.6 },
  minamisenju: { ueno: 1.4, kitasenju: 1.3 },
  kitasenju: { minamisenju: 1.3 },
  // 東西線
  ochiai: { nakano: 1.5, takadanobaba: 1.7 },
  waseda: { takadanobaba: 1.3, kagurazaka: 1.6 },
  kagurazaka: { waseda: 1.6, iidabashi: 0.6 },
  iidabashi: { kagurazaka: 0.6, kudanshita: 1.1 },
  kudanshita: { iidabashi: 1.1, takebashi: 1.0 },
  takebashi: { kudanshita: 1.0, otemachi: 0.9 },
  monzen_nakacho: { kayabacho: 1.5, kiba: 1.1 },
  kiba: { monzen_nakacho: 1.1, tatsumi: 1.0 },
  tatsumi: { kiba: 1.0, minamisuna: 1.5 },
  minamisuna: { tatsumi: 1.5, nishi_kasai: 2.3 },
  nishi_kasai: { minamisuna: 2.3, kasai: 1.4 },
  kasai: { nishi_kasai: 1.4 },
  // 京浜東北線専用
  omiya: { saitama_shintoshin: 1.8 },
  saitama_shintoshin: { omiya: 1.8, yono: 1.4 },
  yono: { saitama_shintoshin: 1.4, kita_urawa: 1.0 },
  kita_urawa: { yono: 1.0, urawa: 1.1 },
  urawa: { kita_urawa: 1.1, minami_urawa: 1.5 },
  minami_urawa: { urawa: 1.5, warabi: 2.3 },
  warabi: { minami_urawa: 2.3, nishi_kawaguchi: 1.6 },
  nishi_kawaguchi: { warabi: 1.6, kawaguchi: 0.8 },
  kawaguchi: { nishi_kawaguchi: 0.8, akabane: 3.2 },
  akabane: { kawaguchi: 3.2, higashi_jujo: 1.6 },
  higashi_jujo: { akabane: 1.6, oji: 1.3 },
  oji: { higashi_jujo: 1.3, kamiya: 1.1 },
  kamiya: { oji: 1.1, tabata: 2.1 },
  oimachi: { shinagawa: 2.5, omori: 1.2 },
  omori: { oimachi: 1.2, kamata: 2.0 },
  kamata: { omori: 2.0, keihin_kawasaki: 3.3 },
  keihin_kawasaki: { kamata: 3.3 },
}

function getDistance(from: string, to: string): number {
  return DISTANCES[from]?.[to] ?? DISTANCES[to]?.[from] ?? 1.5
}

function calcFare(operator: TrainLine['operator'], distanceKm: number): number {
  if (operator === 'JR東日本') {
    if (distanceKm <= 3) return 150
    if (distanceKm <= 6) return 180
    if (distanceKm <= 10) return 200
    if (distanceKm <= 15) return 240
    if (distanceKm <= 20) return 320
    if (distanceKm <= 25) return 400
    if (distanceKm <= 30) return 480
    if (distanceKm <= 35) return 520
    if (distanceKm <= 40) return 560
    return 660
  }
  // 東京メトロ
  if (distanceKm <= 8) return 180
  if (distanceKm <= 14) return 210
  if (distanceKm <= 19) return 240
  if (distanceKm <= 24) return 270
  if (distanceKm <= 30) return 300
  return 330
}

export function buildConnections(): Connection[] {
  const connections: Connection[] = []

  for (const line of LINES) {
    const stations = line.stations
    for (let i = 0; i < stations.length - 1; i++) {
      const from = stations[i]
      const to = stations[i + 1]
      const dist = getDistance(from, to)
      const fare = calcFare(line.operator, dist)
      const time = Math.round(dist * 2.5) // rough minutes per km

      connections.push({ from, to, lineId: line.id, distanceKm: dist, timeMinutes: time })
      connections.push({ from: to, to: from, lineId: line.id, distanceKm: dist, timeMinutes: time })
    }
  }

  return connections
}

// Pre-built connections for export
export const CONNECTIONS: Connection[] = buildConnections()
