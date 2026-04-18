'use client'

import { useState } from 'react'
import { Plus, Trash2, TicketCheck, ChevronDown, ChevronUp } from 'lucide-react'
import { v4 as uuidv4 } from 'uuid'
import type { CommuterPass, PassType } from '@/types'
import { LINES, LINE_MAP } from '@/data/lines'
import { STATION_MAP } from '@/data/stations'
import { calcPassMonthlyFare } from '@/lib/pathfinder'
import StationSelect from './StationSelect'

interface Props {
  passes: CommuterPass[]
  onChange: (passes: CommuterPass[]) => void
}

const PASS_LABELS: Record<PassType, string> = {
  '1month': '1ヶ月',
  '3month': '3ヶ月',
  '6month': '6ヶ月',
}

export default function PassManager({ passes, onChange }: Props) {
  const [adding, setAdding] = useState(false)
  const [lineId, setLineId] = useState('')
  const [fromId, setFromId] = useState('')
  const [toId, setToId] = useState('')
  const [passType, setPassType] = useState<PassType>('1month')
  const [validUntil, setValidUntil] = useState(() => {
    const d = new Date()
    d.setMonth(d.getMonth() + 1)
    return d.toISOString().slice(0, 10)
  })

  const selectedLine = LINE_MAP.get(lineId)

  // Only show stations on the selected line
  const lineStations = selectedLine
    ? selectedLine.stations.map(id => STATION_MAP.get(id)).filter(Boolean)
    : []

  function addPass() {
    if (!lineId || !fromId || !toId || fromId === toId) return
    const pass: CommuterPass = {
      id: uuidv4(),
      lineId,
      fromStationId: fromId,
      toStationId: toId,
      validUntil,
      passType,
    }
    onChange([...passes, pass])
    setAdding(false)
    setLineId('')
    setFromId('')
    setToId('')
  }

  function removePass(id: string) {
    onChange(passes.filter(p => p.id !== id))
  }

  const estimateFare = lineId && fromId && toId && fromId !== toId
    ? calcPassMonthlyFare(lineId, fromId, toId)
    : null

  return (
    <div className="space-y-3">
      {passes.length === 0 && !adding && (
        <p className="text-sm text-gray-500 py-2">定期券が登録されていません</p>
      )}

      {passes.map(pass => {
        const line = LINE_MAP.get(pass.lineId)
        const from = STATION_MAP.get(pass.fromStationId)
        const to = STATION_MAP.get(pass.toStationId)
        const isExpired = new Date(pass.validUntil) < new Date()

        return (
          <div
            key={pass.id}
            className={`flex items-start gap-3 p-3 rounded-lg border ${isExpired ? 'bg-gray-50 border-gray-200 opacity-60' : 'bg-blue-50 border-blue-200'}`}
          >
            <div
              className="w-3 h-3 rounded-full mt-1 flex-shrink-0"
              style={{ backgroundColor: line?.color ?? '#888' }}
            />
            <div className="flex-1 min-w-0">
              <div className="font-medium text-sm text-gray-800">
                {from?.name} → {to?.name}
              </div>
              <div className="text-xs text-gray-500 mt-0.5">
                {line?.name} · {PASS_LABELS[pass.passType]}
              </div>
              <div className={`text-xs mt-0.5 ${isExpired ? 'text-red-500' : 'text-gray-500'}`}>
                {isExpired ? '期限切れ: ' : '有効期限: '}{pass.validUntil}
              </div>
            </div>
            <button
              onClick={() => removePass(pass.id)}
              className="text-gray-400 hover:text-red-500 transition-colors mt-0.5"
            >
              <Trash2 size={15} />
            </button>
          </div>
        )
      })}

      {adding ? (
        <div className="border border-blue-300 rounded-lg p-4 bg-blue-50 space-y-3">
          <h4 className="text-sm font-semibold text-blue-800">定期券を追加</h4>

          <div>
            <label className="text-xs text-gray-600 mb-1 block">路線</label>
            <select
              value={lineId}
              onChange={e => { setLineId(e.target.value); setFromId(''); setToId('') }}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:border-blue-400"
            >
              <option value="">路線を選択...</option>
              {LINES.map(l => (
                <option key={l.id} value={l.id}>{l.name}</option>
              ))}
            </select>
          </div>

          {lineId && (
            <>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="text-xs text-gray-600 mb-1 block">乗車駅</label>
                  <select
                    value={fromId}
                    onChange={e => setFromId(e.target.value)}
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:border-blue-400"
                  >
                    <option value="">選択...</option>
                    {lineStations.map(s => s && (
                      <option key={s.id} value={s.id} disabled={s.id === toId}>{s.name}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="text-xs text-gray-600 mb-1 block">降車駅</label>
                  <select
                    value={toId}
                    onChange={e => setToId(e.target.value)}
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:border-blue-400"
                  >
                    <option value="">選択...</option>
                    {lineStations.map(s => s && (
                      <option key={s.id} value={s.id} disabled={s.id === fromId}>{s.name}</option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="text-xs text-gray-600 mb-1 block">種別</label>
                  <select
                    value={passType}
                    onChange={e => setPassType(e.target.value as PassType)}
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:border-blue-400"
                  >
                    {(Object.entries(PASS_LABELS) as [PassType, string][]).map(([k, v]) => (
                      <option key={k} value={k}>{v}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="text-xs text-gray-600 mb-1 block">有効期限</label>
                  <input
                    type="date"
                    value={validUntil}
                    onChange={e => setValidUntil(e.target.value)}
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:border-blue-400"
                  />
                </div>
              </div>

              {estimateFare && fromId && toId && (
                <div className="text-xs text-blue-700 bg-white rounded-lg p-2 border border-blue-200">
                  参考料金: 1ヶ月 ¥{estimateFare.oneMonth.toLocaleString()} /
                  3ヶ月 ¥{estimateFare.threeMonth.toLocaleString()} /
                  6ヶ月 ¥{estimateFare.sixMonth.toLocaleString()}
                </div>
              )}
            </>
          )}

          <div className="flex gap-2 pt-1">
            <button
              onClick={addPass}
              disabled={!lineId || !fromId || !toId || fromId === toId}
              className="flex-1 bg-blue-600 text-white text-sm font-medium py-2 rounded-lg hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              追加する
            </button>
            <button
              onClick={() => { setAdding(false); setLineId(''); setFromId(''); setToId('') }}
              className="px-4 text-sm text-gray-600 hover:text-gray-800 border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
            >
              キャンセル
            </button>
          </div>
        </div>
      ) : (
        <button
          onClick={() => setAdding(true)}
          className="flex items-center gap-2 text-sm text-blue-600 hover:text-blue-700 font-medium py-1"
        >
          <Plus size={16} />
          定期券を追加
        </button>
      )}
    </div>
  )
}
