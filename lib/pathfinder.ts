import type { Route, RouteSegment, CommuterPass, Connection } from '@/types'
import { STATION_MAP } from '@/data/stations'
import { LINE_MAP, LINES } from '@/data/lines'

function isConnectionCoveredByPass(
  connection: Connection,
  pass: CommuterPass,
): boolean {
  if (connection.lineId !== pass.lineId) return false

  const line = LINE_MAP.get(pass.lineId)
  if (!line) return false

  const stations = line.stations
  const passFromIdx = stations.indexOf(pass.fromStationId)
  const passToIdx = stations.indexOf(pass.toStationId)
  const connFromIdx = stations.indexOf(connection.from)
  const connToIdx = stations.indexOf(connection.to)

  if (passFromIdx === -1 || passToIdx === -1 || connFromIdx === -1 || connToIdx === -1) {
    return false
  }

  const passMin = Math.min(passFromIdx, passToIdx)
  const passMax = Math.max(passFromIdx, passToIdx)
  const connMin = Math.min(connFromIdx, connToIdx)
  const connMax = Math.max(connFromIdx, connToIdx)

  return connMin >= passMin && connMax <= passMax
}

function calcSegmentFare(connection: Connection, passes: CommuterPass[]): {
  fare: number
  coveredByPass: boolean
  passId?: string
} {
  for (const pass of passes) {
    if (isConnectionCoveredByPass(connection, pass)) {
      return { fare: 0, coveredByPass: true, passId: pass.id }
    }
  }

  const line = LINE_MAP.get(connection.lineId)
  if (!line) return { fare: 200, coveredByPass: false }

  // Fare based on operator and distance
  const dist = connection.distanceKm
  let fare: number
  if (line.operator === 'JR東日本') {
    if (dist <= 3) fare = 150
    else if (dist <= 6) fare = 180
    else if (dist <= 10) fare = 200
    else if (dist <= 15) fare = 240
    else if (dist <= 20) fare = 320
    else if (dist <= 25) fare = 400
    else if (dist <= 30) fare = 480
    else fare = 520
  } else {
    // 東京メトロ
    if (dist <= 8) fare = 180
    else if (dist <= 14) fare = 210
    else if (dist <= 19) fare = 240
    else fare = 270
  }

  return { fare, coveredByPass: false }
}

interface GraphEdge {
  to: string
  lineId: string
  cost: number
  originalCost: number
  timeMinutes: number
  coveredByPass: boolean
  passId?: string
  distanceKm: number
}

type Graph = Map<string, GraphEdge[]>

export function buildGraph(connections: Connection[], passes: CommuterPass[]): Graph {
  const graph: Graph = new Map()

  for (const conn of connections) {
    if (!graph.has(conn.from)) graph.set(conn.from, [])
    const { fare, coveredByPass, passId } = calcSegmentFare(conn, passes)
    const line = LINE_MAP.get(conn.lineId)
    let originalFare = fare
    if (coveredByPass) {
      // Calculate what fare would be without the pass
      const dist = conn.distanceKm
      if (line?.operator === 'JR東日本') {
        if (dist <= 3) originalFare = 150
        else if (dist <= 6) originalFare = 180
        else if (dist <= 10) originalFare = 200
        else originalFare = 240
      } else {
        originalFare = 180
      }
    }
    graph.get(conn.from)!.push({
      to: conn.to,
      lineId: conn.lineId,
      cost: fare,
      originalCost: originalFare,
      timeMinutes: conn.timeMinutes,
      coveredByPass,
      passId,
      distanceKm: conn.distanceKm,
    })
  }

  return graph
}

interface DijkstraNode {
  stationId: string
  lineId: string | null
  cost: number
  originalCost: number
  time: number
  path: Array<{
    from: string
    to: string
    lineId: string
    fare: number
    originalFare: number
    coveredByPass: boolean
    passId?: string
    timeMinutes: number
  }>
}

export function findCheapestRoute(
  fromId: string,
  toId: string,
  graph: Graph,
): Route | null {
  if (fromId === toId) return null
  if (!graph.has(fromId) || !graph.has(toId)) return null

  const dist = new Map<string, number>()
  const pq: DijkstraNode[] = []

  dist.set(fromId, 0)
  pq.push({ stationId: fromId, lineId: null, cost: 0, originalCost: 0, time: 0, path: [] })

  while (pq.length > 0) {
    pq.sort((a, b) => a.cost - b.cost)
    const current = pq.shift()!

    if (current.stationId === toId) {
      return buildRoute(current.path)
    }

    const prevCost = dist.get(current.stationId) ?? Infinity
    if (current.cost > prevCost) continue

    const edges = graph.get(current.stationId) ?? []
    for (const edge of edges) {
      const newCost = current.cost + edge.cost
      const existing = dist.get(edge.to) ?? Infinity

      if (newCost < existing) {
        dist.set(edge.to, newCost)
        pq.push({
          stationId: edge.to,
          lineId: edge.lineId,
          cost: newCost,
          originalCost: current.originalCost + edge.originalCost,
          time: current.time + edge.timeMinutes,
          path: [
            ...current.path,
            {
              from: current.stationId,
              to: edge.to,
              lineId: edge.lineId,
              fare: edge.cost,
              originalFare: edge.originalCost,
              coveredByPass: edge.coveredByPass,
              passId: edge.passId,
              timeMinutes: edge.timeMinutes,
            },
          ],
        })
      }
    }
  }

  return null
}

function buildRoute(
  path: Array<{
    from: string
    to: string
    lineId: string
    fare: number
    originalFare: number
    coveredByPass: boolean
    passId?: string
    timeMinutes: number
  }>,
): Route {
  const segments: RouteSegment[] = path.map(step => {
    const fromStation = STATION_MAP.get(step.from)!
    const toStation = STATION_MAP.get(step.to)!
    const line = LINE_MAP.get(step.lineId)!
    return {
      fromStation,
      toStation,
      line,
      fare: step.fare,
      coveredByPass: step.coveredByPass,
      passId: step.passId,
      timeMinutes: step.timeMinutes,
    }
  })

  // Merge consecutive segments on same line
  const merged: RouteSegment[] = []
  for (const seg of segments) {
    const last = merged[merged.length - 1]
    if (last && last.line.id === seg.line.id && last.coveredByPass === seg.coveredByPass) {
      last.toStation = seg.toStation
      last.fare += seg.fare
      last.timeMinutes += seg.timeMinutes
    } else {
      merged.push({ ...seg })
    }
  }

  const totalFare = merged.reduce((sum, s) => sum + s.fare, 0)
  const originalFare = path.reduce((sum, s) => sum + s.originalFare, 0)
  const totalTime = merged.reduce((sum, s) => sum + s.timeMinutes, 0)

  // Count transfers (line changes)
  let transfers = 0
  for (let i = 1; i < merged.length; i++) {
    if (merged[i].line.id !== merged[i - 1].line.id) transfers++
  }

  return {
    segments: merged,
    totalFare,
    originalFare,
    savings: Math.max(0, originalFare - totalFare),
    totalTimeMinutes: totalTime,
    transfers,
  }
}

export function findTopRoutes(
  fromId: string,
  toId: string,
  graph: Graph,
  count = 3,
): Route[] {
  // Find cheapest route
  const best = findCheapestRoute(fromId, toId, graph)
  if (!best) return []

  const routes: Route[] = [best]

  // Find alternative routes by temporarily removing edges
  const allEdges = Array.from(graph.entries())
  const tried = new Set<string>()

  for (const seg of best.segments) {
    const key = `${seg.fromStation.id}-${seg.toStation.id}-${seg.line.id}`
    if (tried.has(key) || routes.length >= count) continue
    tried.add(key)

    // Create modified graph without this segment
    const modifiedGraph: Graph = new Map()
    for (const [node, edges] of allEdges) {
      modifiedGraph.set(
        node,
        edges.filter(
          e => !(e.to === seg.toStation.id && e.lineId === seg.line.id && node === seg.fromStation.id) &&
               !(e.to === seg.fromStation.id && e.lineId === seg.line.id && node === seg.toStation.id),
        ),
      )
    }

    const alt = findCheapestRoute(fromId, toId, modifiedGraph)
    if (alt && alt.totalFare !== best.totalFare) {
      // Check not duplicate
      const isDup = routes.some(r =>
        r.segments.map(s => s.line.id).join(',') === alt.segments.map(s => s.line.id).join(',')
      )
      if (!isDup) routes.push(alt)
    }
  }

  return routes.sort((a, b) => a.totalFare - b.totalFare).slice(0, count)
}

export function formatTime(minutes: number): string {
  if (minutes < 60) return `${minutes}分`
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return m > 0 ? `${h}時間${m}分` : `${h}時間`
}

export function getStationsOnLine(lineId: string): string[] {
  return LINE_MAP.get(lineId)?.stations ?? []
}

export function getStationsBetween(lineId: string, fromId: string, toId: string): string[] {
  const stations = getStationsOnLine(lineId)
  const a = stations.indexOf(fromId)
  const b = stations.indexOf(toId)
  if (a === -1 || b === -1) return []
  const [lo, hi] = a < b ? [a, b] : [b, a]
  return stations.slice(lo, hi + 1)
}

export function calcPassMonthlyFare(lineId: string, fromId: string, toId: string): {
  oneMonth: number
  threeMonth: number
  sixMonth: number
} {
  const line = LINE_MAP.get(lineId)
  if (!line) return { oneMonth: 0, threeMonth: 0, sixMonth: 0 }

  const stations = line.stations
  const a = stations.indexOf(fromId)
  const b = stations.indexOf(toId)
  if (a === -1 || b === -1) return { oneMonth: 0, threeMonth: 0, sixMonth: 0 }

  // Total distance between the two stations
  const [lo, hi] = a < b ? [a, b] : [b, a]
  let totalDist = 0
  for (let i = lo; i < hi; i++) {
    const from = stations[i]
    const to = stations[i + 1]
    // Find connection distance
    const LINES_DATA = LINES
    const lineData = LINES_DATA.find(l => l.id === lineId)
    if (lineData) {
      // approximate 1.5km per stop
      totalDist += 1.5
    }
  }
  totalDist = Math.max(totalDist, (hi - lo) * 1.5)

  const stops = hi - lo
  const oneWayFare = line.operator === 'JR東日本'
    ? (totalDist <= 3 ? 150 : totalDist <= 6 ? 180 : totalDist <= 10 ? 200 : totalDist <= 15 ? 240 : 320)
    : (totalDist <= 8 ? 180 : totalDist <= 14 ? 210 : 240)

  // Monthly pass ≈ oneWayFare × 2 × 20 working days × 0.6 discount
  const oneMonth = Math.round(oneWayFare * 2 * 20 * 0.6 / 10) * 10
  const threeMonth = Math.round(oneMonth * 3 * 0.9 / 10) * 10
  const sixMonth = Math.round(oneMonth * 6 * 0.8 / 10) * 10

  return { oneMonth, threeMonth, sixMonth }
}
