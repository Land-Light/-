'use client'

import { useState, useEffect, useMemo, useCallback } from 'react'
import dynamic from 'next/dynamic'
import {
  TrainFront, TicketCheck, Search, ChevronDown, ChevronUp, RefreshCw,
  MapPin, ArrowUpDown
} from 'lucide-react'
import type { CommuterPass, Route, Station } from '@/types'
import { STATION_MAP } from '@/data/stations'
import { CONNECTIONS } from '@/data/lines'
import { buildGraph, findTopRoutes } from '@/lib/pathfinder'
import StationSelect from '@/components/StationSelect'
import PassManager from '@/components/PassManager'
import RouteResults from '@/components/RouteResults'

const MapView = dynamic(() => import('@/components/MapView'), { ssr: false })

const STORAGE_KEY = 'commuter-passes-v1'

export default function Home() {
  const [passes, setPasses] = useState<CommuterPass[]>([])
  const [fromId, setFromId] = useState('')
  const [toId, setToId] = useState('')
  const [routes, setRoutes] = useState<Route[]>([])
  const [selectedRoute, setSelectedRoute] = useState(0)
  const [searching, setSearching] = useState(false)
  const [searched, setSearched] = useState(false)
  const [passOpen, setPassOpen] = useState(true)

  // Load passes from localStorage
  useEffect(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY)
      if (stored) setPasses(JSON.parse(stored))
    } catch {}
  }, [])

  // Persist passes
  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(passes))
  }, [passes])

  const graph = useMemo(
    () => buildGraph(CONNECTIONS, passes.filter(p => new Date(p.validUntil) >= new Date())),
    [passes],
  )

  function search() {
    if (!fromId || !toId) return
    setSearching(true)
    setSearched(false)
    setTimeout(() => {
      const results = findTopRoutes(fromId, toId, graph, 3)
      setRoutes(results)
      setSelectedRoute(0)
      setSearched(true)
      setSearching(false)
    }, 300)
  }

  function swapStations() {
    const tmp = fromId
    setFromId(toId)
    setToId(tmp)
    setRoutes([])
    setSearched(false)
  }

  const fromStation = fromId ? (STATION_MAP.get(fromId) ?? null) : null
  const toStation = toId ? (STATION_MAP.get(toId) ?? null) : null
  const currentRoute = routes[selectedRoute] ?? null

  const activePasses = passes.filter(p => new Date(p.validUntil) >= new Date())

  return (
    <div className="flex flex-col h-screen bg-gray-50">
      {/* Header */}
      <header className="bg-white border-b border-gray-200 px-5 py-3.5 flex items-center gap-3 shadow-sm z-10">
        <div className="flex items-center gap-2.5">
          <div className="bg-blue-600 p-2 rounded-xl">
            <TrainFront size={20} className="text-white" />
          </div>
          <div>
            <h1 className="text-lg font-bold text-gray-900 leading-tight">通勤定期ルート検索</h1>
            <p className="text-xs text-gray-500">定期券を登録して最安ルートを探す</p>
          </div>
        </div>
        {activePasses.length > 0 && (
          <div className="ml-auto flex items-center gap-1.5 bg-green-50 text-green-700 text-xs font-medium px-3 py-1.5 rounded-full border border-green-200">
            <TicketCheck size={13} />
            定期券 {activePasses.length}件 有効
          </div>
        )}
      </header>

      <div className="flex flex-1 min-h-0">
        {/* Left Panel */}
        <div className="w-96 flex-shrink-0 flex flex-col bg-white border-r border-gray-200 overflow-y-auto">
          {/* Route Search */}
          <div className="p-5 border-b border-gray-100">
            <h2 className="text-sm font-semibold text-gray-700 mb-3 flex items-center gap-2">
              <Search size={15} className="text-blue-600" />
              ルート検索
            </h2>

            <div className="relative space-y-2">
              <div>
                <label className="text-xs text-gray-500 mb-1 block">出発駅</label>
                <StationSelect
                  value={fromId}
                  onChange={id => { setFromId(id); setRoutes([]); setSearched(false) }}
                  placeholder="出発駅を選択"
                  excludeId={toId}
                />
              </div>

              {/* Swap button */}
              <div className="flex justify-center">
                <button
                  onClick={swapStations}
                  className="p-1.5 rounded-full hover:bg-gray-100 text-gray-400 hover:text-gray-600 transition-colors"
                  title="出発・到着を入れ替え"
                >
                  <ArrowUpDown size={16} />
                </button>
              </div>

              <div>
                <label className="text-xs text-gray-500 mb-1 block">到着駅</label>
                <StationSelect
                  value={toId}
                  onChange={id => { setToId(id); setRoutes([]); setSearched(false) }}
                  placeholder="到着駅を選択"
                  excludeId={fromId}
                />
              </div>
            </div>

            <button
              onClick={search}
              disabled={!fromId || !toId || searching}
              className="mt-4 w-full bg-blue-600 hover:bg-blue-700 disabled:bg-gray-300 disabled:cursor-not-allowed text-white font-semibold py-2.5 px-4 rounded-xl transition-colors flex items-center justify-center gap-2"
            >
              {searching ? (
                <>
                  <RefreshCw size={16} className="animate-spin" />
                  検索中...
                </>
              ) : (
                <>
                  <Search size={16} />
                  最安ルートを検索
                </>
              )}
            </button>
          </div>

          {/* Route Results */}
          {searched && (
            <div className="p-5 border-b border-gray-100">
              <h2 className="text-sm font-semibold text-gray-700 mb-3 flex items-center gap-2">
                <MapPin size={15} className="text-blue-600" />
                検索結果
                {fromStation && toStation && (
                  <span className="text-xs text-gray-400 font-normal">
                    {fromStation.name} → {toStation.name}
                  </span>
                )}
              </h2>
              {routes.length === 0 ? (
                <div className="text-sm text-gray-500 py-4 text-center">
                  <div className="text-3xl mb-2">🚫</div>
                  ルートが見つかりませんでした
                </div>
              ) : (
                <RouteResults
                  routes={routes}
                  selectedIndex={selectedRoute}
                  onSelect={setSelectedRoute}
                />
              )}
            </div>
          )}

          {/* Commuter Pass Manager */}
          <div className="p-5">
            <button
              onClick={() => setPassOpen(!passOpen)}
              className="w-full flex items-center justify-between mb-3"
            >
              <h2 className="text-sm font-semibold text-gray-700 flex items-center gap-2">
                <TicketCheck size={15} className="text-blue-600" />
                登録済み定期券
                {passes.length > 0 && (
                  <span className="bg-blue-100 text-blue-700 text-[10px] font-bold px-1.5 py-0.5 rounded-full">
                    {passes.length}
                  </span>
                )}
              </h2>
              {passOpen ? <ChevronUp size={16} className="text-gray-400" /> : <ChevronDown size={16} className="text-gray-400" />}
            </button>

            {passOpen && (
              <PassManager passes={passes} onChange={newPasses => {
                setPasses(newPasses)
                if (fromId && toId) {
                  setRoutes([])
                  setSearched(false)
                }
              }} />
            )}
          </div>
        </div>

        {/* Map Area */}
        <div className="flex-1 relative p-4">
          {!searched && !fromStation && !toStation && (
            <div className="absolute inset-0 flex items-center justify-center z-10 pointer-events-none">
              <div className="bg-white rounded-2xl shadow-lg p-8 text-center max-w-xs">
                <div className="text-5xl mb-3">🚃</div>
                <h3 className="text-lg font-bold text-gray-800 mb-2">ルート検索を始めよう</h3>
                <p className="text-sm text-gray-500">
                  左パネルで出発駅・到着駅を選び、<br />
                  定期券を登録すると最安ルートが<br />
                  地図上に表示されます
                </p>
              </div>
            </div>
          )}
          <MapView
            route={currentRoute}
            fromStation={fromStation}
            toStation={toStation}
          />
        </div>
      </div>
    </div>
  )
}
