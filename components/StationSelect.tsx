'use client'

import { useState, useRef, useEffect } from 'react'
import { Search, X } from 'lucide-react'
import { STATIONS } from '@/data/stations'

interface Props {
  value: string
  onChange: (id: string) => void
  placeholder?: string
  excludeId?: string
}

export default function StationSelect({ value, onChange, placeholder = '駅を選択', excludeId }: Props) {
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  const selected = STATIONS.find(s => s.id === value)

  const filtered = STATIONS.filter(s =>
    s.id !== excludeId &&
    (s.name.includes(query) || query === '')
  ).slice(0, 30)

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [])

  function select(id: string) {
    onChange(id)
    setQuery('')
    setOpen(false)
  }

  function clear() {
    onChange('')
    setQuery('')
  }

  return (
    <div ref={ref} className="relative">
      <div
        className="flex items-center border border-gray-300 rounded-lg bg-white cursor-pointer hover:border-blue-400 transition-colors"
        onClick={() => setOpen(true)}
      >
        {open ? (
          <div className="flex items-center w-full px-3 py-2">
            <Search size={16} className="text-gray-400 mr-2 flex-shrink-0" />
            <input
              autoFocus
              className="flex-1 outline-none text-sm bg-transparent"
              placeholder="駅名を入力..."
              value={query}
              onChange={e => setQuery(e.target.value)}
              onClick={e => e.stopPropagation()}
            />
          </div>
        ) : (
          <div className="flex items-center w-full px-3 py-2 min-h-[38px]">
            <Search size={16} className="text-gray-400 mr-2 flex-shrink-0" />
            {selected ? (
              <span className="flex-1 text-sm font-medium text-gray-800">{selected.name}</span>
            ) : (
              <span className="flex-1 text-sm text-gray-400">{placeholder}</span>
            )}
            {selected && (
              <button
                onClick={e => { e.stopPropagation(); clear() }}
                className="text-gray-400 hover:text-gray-600 ml-1"
              >
                <X size={14} />
              </button>
            )}
          </div>
        )}
      </div>

      {open && (
        <div className="absolute z-50 mt-1 w-full bg-white border border-gray-200 rounded-lg shadow-lg max-h-56 overflow-y-auto">
          {filtered.length === 0 ? (
            <div className="px-3 py-2 text-sm text-gray-500">該当する駅がありません</div>
          ) : (
            filtered.map(s => (
              <button
                key={s.id}
                className="w-full text-left px-3 py-2 text-sm hover:bg-blue-50 hover:text-blue-700 transition-colors"
                onClick={() => select(s.id)}
              >
                {s.name}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  )
}
