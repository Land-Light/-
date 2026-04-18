'use client'

import { Clock, ArrowRight, Repeat2, Tag, CheckCircle2 } from 'lucide-react'
import type { Route } from '@/types'
import { formatTime } from '@/lib/pathfinder'

interface Props {
  routes: Route[]
  selectedIndex: number
  onSelect: (index: number) => void
}

export default function RouteResults({ routes, selectedIndex, onSelect }: Props) {
  if (routes.length === 0) return null

  return (
    <div className="space-y-3">
      {routes.map((route, i) => (
        <button
          key={i}
          onClick={() => onSelect(i)}
          className={`w-full text-left rounded-xl border-2 p-4 transition-all ${
            i === selectedIndex
              ? 'border-blue-500 bg-blue-50 shadow-md'
              : 'border-gray-200 bg-white hover:border-blue-300 hover:shadow-sm'
          }`}
        >
          <div className="flex items-start justify-between mb-3">
            <div className="flex items-baseline gap-1">
              {i === 0 && (
                <span className="text-xs bg-green-500 text-white px-2 py-0.5 rounded-full font-medium mr-1">
                  最安
                </span>
              )}
              <span className="text-2xl font-bold text-gray-900">
                ¥{route.totalFare.toLocaleString()}
              </span>
              {route.savings > 0 && (
                <span className="text-sm text-gray-500 line-through ml-1">
                  ¥{route.originalFare.toLocaleString()}
                </span>
              )}
            </div>
            <div className="flex items-center gap-3 text-xs text-gray-500">
              <span className="flex items-center gap-1">
                <Clock size={12} />
                {formatTime(route.totalTimeMinutes)}
              </span>
              <span className="flex items-center gap-1">
                <Repeat2 size={12} />
                乗換{route.transfers}回
              </span>
            </div>
          </div>

          {route.savings > 0 && (
            <div className="flex items-center gap-1.5 text-green-600 text-xs font-medium mb-3 bg-green-50 px-2 py-1.5 rounded-lg">
              <Tag size={12} />
              定期券利用で ¥{route.savings.toLocaleString()} 節約
            </div>
          )}

          {/* Route segments */}
          <div className="flex flex-wrap items-center gap-1.5 text-xs">
            {route.segments.map((seg, j) => (
              <div key={j} className="flex items-center gap-1.5">
                {j > 0 && (
                  <span className="text-gray-400 text-[10px]">乗換</span>
                )}
                <div className="flex items-center gap-1">
                  <div
                    className="w-2 h-2 rounded-full flex-shrink-0"
                    style={{ backgroundColor: seg.line.color }}
                  />
                  <span className="text-gray-700 font-medium">{seg.fromStation.name}</span>
                  <ArrowRight size={10} className="text-gray-400" />
                  <span className="text-gray-700 font-medium">{seg.toStation.name}</span>
                </div>
                {seg.coveredByPass ? (
                  <span className="flex items-center gap-0.5 text-[10px] bg-green-100 text-green-700 px-1.5 py-0.5 rounded-full">
                    <CheckCircle2 size={9} />
                    定期
                  </span>
                ) : (
                  <span className="text-[10px] text-gray-500">
                    ¥{seg.fare}
                  </span>
                )}
              </div>
            ))}
          </div>

          {/* Line tags */}
          <div className="flex flex-wrap gap-1.5 mt-3">
            {[...new Set(route.segments.map(s => s.line.id))].map(lineId => {
              const seg = route.segments.find(s => s.line.id === lineId)!
              return (
                <span
                  key={lineId}
                  className="text-[10px] px-2 py-0.5 rounded-full text-white font-medium"
                  style={{ backgroundColor: seg.line.color }}
                >
                  {seg.line.name}
                </span>
              )
            })}
          </div>
        </button>
      ))}
    </div>
  )
}
