'use client'

import { useEffect, useRef } from 'react'
import type { Route, Station } from '@/types'
import { STATIONS } from '@/data/stations'

interface Props {
  route: Route | null
  fromStation: Station | null
  toStation: Station | null
}

// Use Leaflet via dynamic import to avoid SSR issues
export default function MapView({ route, fromStation, toStation }: Props) {
  const mapRef = useRef<HTMLDivElement>(null)
  const leafletMapRef = useRef<unknown>(null)
  const layersRef = useRef<unknown[]>([])

  useEffect(() => {
    if (typeof window === 'undefined') return
    if (!mapRef.current) return

    async function initMap() {
      const L = (await import('leaflet')).default

      // Fix default icon paths
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      delete (L.Icon.Default.prototype as any)._getIconUrl
      L.Icon.Default.mergeOptions({
        iconRetinaUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png',
        iconUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
        shadowUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png',
      })

      if (!leafletMapRef.current) {
        const map = L.map(mapRef.current!, {
          center: [35.6812, 139.7671],
          zoom: 12,
          zoomControl: true,
        })

        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
          attribution: '© OpenStreetMap contributors',
          maxZoom: 19,
        }).addTo(map)

        leafletMapRef.current = map
      }

      const map = leafletMapRef.current as ReturnType<typeof L.map>

      // Clear previous layers
      for (const layer of layersRef.current) {
        map.removeLayer(layer as ReturnType<typeof L.marker>)
      }
      layersRef.current = []

      function addLayer(layer: unknown) {
        map.addLayer(layer as ReturnType<typeof L.marker>)
        layersRef.current.push(layer)
      }

      if (route) {
        // Draw route segments
        for (const seg of route.segments) {
          const color = seg.coveredByPass ? '#22c55e' : seg.line.color
          const weight = seg.coveredByPass ? 6 : 4

          // Collect all stations in this segment for the polyline
          const stationIds: string[] = []
          const lineStations = seg.line.stations
          const fromIdx = lineStations.indexOf(seg.fromStation.id)
          const toIdx = lineStations.indexOf(seg.toStation.id)

          if (fromIdx !== -1 && toIdx !== -1) {
            const [lo, hi] = fromIdx < toIdx ? [fromIdx, toIdx] : [toIdx, fromIdx]
            const slice = fromIdx < toIdx
              ? lineStations.slice(lo, hi + 1)
              : lineStations.slice(lo, hi + 1).reverse()

            const latlngs = slice
              .map(id => STATIONS.find(s => s.id === id))
              .filter(Boolean)
              .map(s => [s!.lat, s!.lng] as [number, number])

            if (latlngs.length >= 2) {
              const line = L.polyline(latlngs, {
                color,
                weight,
                opacity: 0.85,
                dashArray: seg.coveredByPass ? undefined : undefined,
              })
              addLayer(line)
            }
          }
        }

        // Start marker (green)
        const startStation = route.segments[0].fromStation
        const startIcon = L.divIcon({
          html: `<div style="background:#22c55e;color:white;border-radius:50%;width:28px;height:28px;display:flex;align-items:center;justify-content:center;font-weight:bold;font-size:13px;border:2px solid white;box-shadow:0 2px 6px rgba(0,0,0,0.4)">出</div>`,
          className: '',
          iconSize: [28, 28],
          iconAnchor: [14, 14],
        })
        const startMarker = L.marker([startStation.lat, startStation.lng], { icon: startIcon })
          .bindTooltip(startStation.name, { permanent: false })
        addLayer(startMarker)

        // End marker (red)
        const endStation = route.segments[route.segments.length - 1].toStation
        const endIcon = L.divIcon({
          html: `<div style="background:#ef4444;color:white;border-radius:50%;width:28px;height:28px;display:flex;align-items:center;justify-content:center;font-weight:bold;font-size:13px;border:2px solid white;box-shadow:0 2px 6px rgba(0,0,0,0.4)">着</div>`,
          className: '',
          iconSize: [28, 28],
          iconAnchor: [14, 14],
        })
        const endMarker = L.marker([endStation.lat, endStation.lng], { icon: endIcon })
          .bindTooltip(endStation.name, { permanent: false })
        addLayer(endMarker)

        // Transfer markers
        for (let i = 0; i < route.segments.length - 1; i++) {
          const seg = route.segments[i]
          const transferIcon = L.divIcon({
            html: `<div style="background:#f59e0b;color:white;border-radius:50%;width:20px;height:20px;display:flex;align-items:center;justify-content:center;font-size:10px;border:2px solid white;box-shadow:0 2px 4px rgba(0,0,0,0.3)">乗</div>`,
            className: '',
            iconSize: [20, 20],
            iconAnchor: [10, 10],
          })
          const transferMarker = L.marker([seg.toStation.lat, seg.toStation.lng], { icon: transferIcon })
            .bindTooltip(`乗換: ${seg.toStation.name}`, { permanent: false })
          addLayer(transferMarker)
        }

        // Fit bounds to route
        const allLatLngs = route.segments.flatMap(s => [
          [s.fromStation.lat, s.fromStation.lng] as [number, number],
          [s.toStation.lat, s.toStation.lng] as [number, number],
        ])
        if (allLatLngs.length > 0) {
          map.fitBounds(L.latLngBounds(allLatLngs), { padding: [40, 40] })
        }
      } else if (fromStation || toStation) {
        // Show selected stations
        const stations = [fromStation, toStation].filter(Boolean) as Station[]
        for (const st of stations) {
          const marker = L.marker([st.lat, st.lng])
            .bindTooltip(st.name, { permanent: true })
          addLayer(marker)
        }
        if (stations.length > 0) {
          const latlngs = stations.map(s => [s.lat, s.lng] as [number, number])
          map.fitBounds(L.latLngBounds(latlngs), { padding: [80, 80] })
        }
      }
    }

    initMap()
  }, [route, fromStation, toStation])

  return (
    <div className="relative w-full h-full">
      <div ref={mapRef} className="w-full h-full rounded-xl" />
      {route && (
        <div className="absolute bottom-4 left-4 bg-white rounded-lg shadow-lg p-3 text-xs space-y-1.5 z-[1000]">
          <div className="font-semibold text-gray-700 mb-1">凡例</div>
          <div className="flex items-center gap-2">
            <div className="w-6 h-1.5 bg-green-500 rounded" />
            <span>定期券区間</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="w-6 h-1 bg-blue-500 rounded" />
            <span>通常区間</span>
          </div>
        </div>
      )}
    </div>
  )
}
