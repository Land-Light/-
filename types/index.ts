export interface Station {
  id: string
  name: string
  lat: number
  lng: number
}

export interface TrainLine {
  id: string
  name: string
  operator: 'JR東日本' | '東京メトロ' | '東急電鉄' | '小田急電鉄'
  color: string
  stations: string[] // ordered station IDs
}

export interface Connection {
  from: string
  to: string
  lineId: string
  distanceKm: number
  timeMinutes: number
}

export type PassType = '1month' | '3month' | '6month'

export interface CommuterPass {
  id: string
  lineId: string
  fromStationId: string
  toStationId: string
  validUntil: string
  passType: PassType
}

export interface RouteSegment {
  fromStation: Station
  toStation: Station
  line: TrainLine
  fare: number
  coveredByPass: boolean
  passId?: string
  timeMinutes: number
}

export interface Route {
  segments: RouteSegment[]
  totalFare: number
  originalFare: number
  savings: number
  totalTimeMinutes: number
  transfers: number
}
