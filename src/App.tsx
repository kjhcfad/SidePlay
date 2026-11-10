import { useCallback, useEffect, useRef, useState } from 'react'
import { supabase, configured } from './lib/supabase'
import { loadYouTubeApi } from './lib/youtube'
import type { Track, QueueItem, Playback, Participant, Room } from './lib/types'
import { ArrowLeft, Check, ChevronDown, Copy, Headphones, Link2, Loader2, LogOut, Music2, Pause, Play, Plus, Radio, Search, Settings2, SkipForward, Users, Volume2, X } from 'lucide-react'

const emptyPlayback: Playback = { track: null, playing: false, position: 0, updatedAt: Date.now(), changedBy: '' }
const getNickname = () => localStorage.getItem('sideplay-nickname') || ''
const getCodeFromUrl = () => new URLSearchParams(location.search).get('room')?.toUpperCase() || ''
const formatTime = (n: number) => `${Math.floor(n / 60)}:${String(Math.floor(n % 60)).padStart(2, '0')}`
const currentPosition = (p: Playback) => Math.max(0, p.position + (p.playing ? (Date.now() - p.updatedAt) / 1000 : 0))

export default function App() {
  const [nickname, setNickname] = useState(getNickname())
  const [room, setRoom] = useState<Room | null>(null)
  const [participants, setParticipants] = useState<Participant[]>([])
  const [userId, setUserId] = useState('')
  const [codeInput, setCodeInput] = useState(getCodeFromUrl())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<Track[]>([])
  const [searching, setSearching] = useState(false)
  const [toast, setToast] = useState('')
  const [audioReady, setAudioReady] = useState(false)
  const [localPosition, setLocalPosition] = useState(0)
  const [localDuration, setLocalDuration] = useState(0)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [mobileTab, setMobileTab] = useState<'queue'|'people'>('queue')
  const playerRef = useRef<any>(null)
  const playerHostRef = useRef<HTMLDivElement>(null)
  const roomRef = useRef<Room | null>(null)
  const userRef = useRef('')
  const channelRef = useRef<any>(null)
  const correctionRef = useRef<number | null>(null)
  const lastCommandRef = useRef(0)

  useEffect(() => { roomRef.current = room }, [room])
  useEffect(() => { userRef.current = userId }, [userId])
  const notify = (message: string) => { setToast(message); window.setTimeout(() => setToast(''), 2600) }

  const ensureUser = useCallback(async () => {
    if (!supabase) throw new Error('Add your Supabase URL and anon key to .env.local first.')
    const { data: { session } } = await supabase.auth.getSession()
    if (session?.user) { setUserId(session.user.id); return session.user.id }
    const { data, error } = await supabase.auth.signInAnonymously()
    if (error || !data.user) throw new Error(error?.message || 'Could not start an anonymous session.')
    setUserId(data.user.id)
    return data.user.id
  }, [])

  const refreshRoom = useCallback(async (roomId: string) => {
    if (!supabase) return
    const { data, error } = await supabase.from('rooms').select('*').eq('id', roomId).single()
    if (error) throw error
    setRoom(data as Room)
    const { data: people } = await supabase.from('participants').select('*').eq('room_id', roomId).order('joined_at')
    setParticipants((people || []) as Participant[])
  }, [])

  const leaveRoom = useCallback(async () => {
    const active = roomRef.current
    if (supabase && active && userRef.current) {
      await supabase.rpc('leave_room', { p_room_id: active.id }).catch(() => {})
      await supabase.removeChannel(channelRef.current).catch(() => {})
    }
    channelRef.current = null
    setRoom(null); setParticipants([]); setResults([]); setAudioReady(false)
    if (playerRef.current) { try { playerRef.current.stopVideo(); playerRef.current.destroy() } catch {} playerRef.current = null }
    history.replaceState({}, '', location.pathname)
  }, [])

  const enterRoom = useCallback(async (roomCode: string) => {
    setBusy(true); setError('')
    try {
      const uid = await ensureUser()
      const { data, error } = await supabase!.rpc('join_room', { p_code: roomCode.trim().toUpperCase(), p_nickname: nickname.trim() || 'Guest' })
      if (error) throw error
      const joined = data as string
      await refreshRoom(joined)
      history.replaceState({}, '', `${location.pathname}?room=${roomCode.toUpperCase()}`)
      const channel = supabase!.channel(`room:${joined}`)
      channel.on('postgres_changes', { event: '*', schema: 'public', table: 'rooms', filter: `id=eq.${joined}` }, payload => {
        if (payload.new && Object.keys(payload.new).length) setRoom(payload.new as Room)
      }).on('postgres_changes', { event: '*', schema: 'public', table: 'participants', filter: `room_id=eq.${joined}` }, async () => {
        const { data: people } = await supabase!.from('participants').select('*').eq('room_id', joined).order('joined_at')
        setParticipants((people || []) as Participant[])
      }).subscribe()
      channelRef.current = channel
      setUserId(uid)
    } catch (e: any) { setError(e.message || 'Could not join room.') }
    finally { setBusy(false) }
  }, [ensureUser, nickname, refreshRoom])

  const createRoom = async () => {
    setBusy(true); setError('')
    try {
      const uid = await ensureUser()
      const { data, error } = await supabase!.rpc('create_room', { p_nickname: nickname.trim() || 'Host' })
      if (error) throw error
      const created = data as string
      const { data: row, error: readError } = await supabase!.from('rooms').select('code').eq('id', created).single()
      if (readError) throw readError
      await enterRoom(row.code)
    } catch (e: any) { setError(e.message || 'Could not create room.') }
    finally { setBusy(false) }
  }

  useEffect(() => { if (configured && getCodeFromUrl() && !room && nickname) void enterRoom(getCodeFromUrl()) }, []) // invite-link entry

  useEffect(() => {
    if (!room?.playback.track || !playerHostRef.current) return
    let cancelled = false
    const setup = async () => {
      const YT = await loadYouTubeApi()
      if (cancelled || !playerHostRef.current) return
      if (playerRef.current) { try { playerRef.current.destroy() } catch {} }
      playerRef.current = new YT.Player(playerHostRef.current, {
        width: '100%', height: '100%', videoId: room.playback.track!.videoId,
        playerVars: { autoplay: 0, controls: 0, rel: 0, playsinline: 1, modestbranding: 1, origin: location.origin },
        events: {
          onReady: (event: any) => { if (!cancelled) { setAudioReady(false); setLocalDuration(event.target.getDuration?.() || 0) } },
          onStateChange: (event: any) => {
            if (event.data === YT.PlayerState.PLAYING) setAudioReady(true)
          },
          onError: () => notify('This video cannot be embedded. Try another track.')
        }
      })
    }
    void setup()
    return () => { cancelled = true }
  }, [room?.playback.track?.videoId])

  // Periodically correct drift against the shared playback clock.
  useEffect(() => {
    if (!room?.playback.track || !playerRef.current) return
    const timer = window.setInterval(() => {
      const p = roomRef.current?.playback
      const player = playerRef.current
      if (!p || !player || player.getPlayerState?.() === -1) return
      const target = currentPosition(p)
      setLocalPosition(target)
      setLocalDuration(player.getDuration?.() || 0)
      const actual = player.getCurrentTime?.() ?? 0
      const drift = Math.abs(actual - target)
      if (p.playing && player.getPlayerState?.() !== 1) {
        if (audioReady) player.playVideo?.()
      } else if (!p.playing && player.getPlayerState?.() === 1) player.pauseVideo?.()
      if (drift > 2.0 && Date.now() - lastCommandRef.current > 3500) player.seekTo?.(target, true)
    }, 1800)
    correctionRef.current = timer
    return () => window.clearInterval(timer)
  }, [room?.playback, audioReady])

  const canControl = Boolean(room && (room.host_id === userId || room.allow_controls))
  const savePlayback = async (patch: Partial<Playback>) => {
    if (!room || !supabase || !canControl) return
    const base = room.playback
    const next = { ...base, ...patch, updatedAt: Date.now(), changedBy: userId }
    lastCommandRef.current = Date.now()
    const { error } = await supabase.rpc('set_playback', { p_room_id: room.id, p_playback: next })
    if (error) notify(error.message)
  }
  const togglePlayback = async () => {
    if (!room?.playback.track) return
    const playing = !room.playback.playing
    if (playing) { playerRef.current?.seekTo?.(currentPosition(room.playback), true); playerRef.current?.playVideo?.() }
    else playerRef.current?.pauseVideo?.()
    await savePlayback({ playing, position: playerRef.current?.getCurrentTime?.() ?? currentPosition(room.playback) })
  }
  const skipTrack = async () => {
    if (!room || !canControl) return
    const queue = [...room.queue]
    const next = queue.shift()
    const historyList = room.playback.track ? [room.playback.track, ...room.history].slice(0, 30) : room.history
    const playback: Playback = { track: next || null, playing: Boolean(next), position: 0, updatedAt: Date.now(), changedBy: userId }
    const { error } = await supabase!.rpc('advance_queue', { p_room_id: room.id, p_playback: playback, p_queue: queue, p_history: historyList })
    if (error) notify(error.message)
  }
  const addTrack = async (track: Track) => {
    if (!room || !supabase) return
    const { error } = await supabase.rpc('add_to_queue', { p_room_id: room.id, p_track: track, p_nickname: nickname.trim() || 'Guest' })
    if (error) notify(error.message); else notify('Added to the shared queue')
  }
  const removeTrack = async (id: string) => {
    if (!room) return
    const { error } = await supabase!.rpc('remove_from_queue', { p_room_id: room.id, p_item_id: id })
    if (error) notify(error.message)
  }
  const searchTracks = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!query.trim()) return
    setSearching(true); setError('')
    try {
      const { data, error } = await supabase!.functions.invoke('search-youtube', { body: { query: query.trim() } })
      if (error) throw error
      setResults((data?.items || []) as Track[])
      if (!data?.items?.length) notify('No results found')
    } catch (e: any) { setError(e.message || 'Search failed. Check the YouTube API setup.') }
    finally { setSearching(false) }
  }
  const copyInvite = async () => {
    await navigator.clipboard.writeText(`${location.origin}${location.pathname}?room=${room?.code}`)
    notify('Invite link copied')
  }
  const activateAudio = () => {
    setAudioReady(true)
    const p = room?.playback
    if (p?.track && p.playing) { playerRef.current?.seekTo?.(currentPosition(p), true); playerRef.current?.playVideo?.() }
  }

  if (!configured) return <SetupScreen />
  if (!room) return <main className="landing">
    <nav className="topbar"><a className="brand" href="#"><span className="brand-icon"><Headphones size={19}/></span>sideplay<span className="brand-dot">.</span></a><span className="top-note"><span className="live-dot"/> FREE LISTENING ROOMS</span></nav>
    <section className="hero">
      <div className="hero-copy"><div className="eyebrow"><span className="eyebrow-line"/> YOUR MUSIC, TOGETHER</div>
        <h1>Same song.<br/><span>Different places.</span></h1>
        <p className="hero-sub">Make a room, invite your people, and press play together. No premium subscription. No accounts to create.</p>
        <div className="hero-actions"><button className="primary-btn" onClick={createRoom} disabled={busy}>{busy ? <Loader2 className="spin"/> : <Radio size={18}/>} Create a room <span>↗</span></button><div className="or">OR</div><form className="join-form" onSubmit={e => {e.preventDefault(); if (nickname.trim()) {localStorage.setItem('sideplay-nickname', nickname); void enterRoom(codeInput)} else setError('Enter a display name first.')}}><input value={codeInput} onChange={e => setCodeInput(e.target.value.toUpperCase())} placeholder="Enter room code" maxLength={8}/><button disabled={busy || !codeInput.trim()}>Join room <ArrowLeft size={15}/></button></form></div>
        <label className="name-label">YOUR DISPLAY NAME<input value={nickname} onChange={e => {setNickname(e.target.value); localStorage.setItem('sideplay-nickname', e.target.value)}} placeholder="What should friends call you?" maxLength={24}/></label>
        {error && <p className="error-text">{error}</p>}
        <div className="hero-foot"><span><span className="green-dot"/> Free to use</span><span>•</span><span>No sign-up required</span><span>•</span><span>Works on any device</span></div>
      </div>
      <div className="hero-art"><div className="orbit orbit-one"/><div className="orbit orbit-two"/><div className="vinyl"><div className="vinyl-label"><Headphones size={30}/></div></div><div className="floating-card card-one"><span className="mini-avatar purple">J</span><div><b>Joel joined</b><small>just now</small></div><span className="equalizer"><i/><i/><i/><i/></span></div><div className="floating-card card-two"><span className="mini-avatar orange">M</span><div><b>Music is playing</b><small>in sync · 4 listeners</small></div><span className="sound-wave">♫</span></div><div className="art-caption">GOOD MUSIC<br/>TRAVELS TOGETHER.</div></div>
    </section><footer className="landing-footer"><span>© 2026 SIDEPLAY</span><span>MADE FOR THE GROUP CHAT</span><span>INDEPENDENT PROJECT · NOT AFFILIATED WITH SPOTIFY OR YOUTUBE</span></footer>
  </main>

  return <main className="room-page">
    <header className="room-topbar"><a className="brand" href="#" onClick={e => {e.preventDefault(); void leaveRoom()}}><span className="brand-icon"><Headphones size={18}/></span>sideplay<span className="brand-dot">.</span></a><div className="room-center"><span className="live-dot"/> LIVE ROOM <b>{room.code}</b></div><div className="top-actions"><button className="icon-btn" title="Room settings" onClick={() => setSettingsOpen(!settingsOpen)}><Settings2 size={18}/></button><button className="invite-btn" onClick={copyInvite}><Link2 size={16}/> Invite friends <Copy size={14}/></button><button className="icon-btn" title="Leave room" onClick={() => void leaveRoom()}><LogOut size={18}/></button></div></header>
    {settingsOpen && <div className="settings-pop"><b>Room settings</b><label className="toggle-row">Everyone can control playback<input type="checkbox" checked={room.allow_controls} disabled={room.host_id !== userId} onChange={e => void supabase!.rpc('set_room_controls', {p_room_id: room.id, p_allow: e.target.checked})}/></label><small>Only the host can change this setting.</small></div>}
    <div className="room-layout">
      <section className="main-column">
        <div className="now-playing-head"><div><div className="eyebrow"><span className="eyebrow-line"/> NOW PLAYING</div><h2>The room's soundtrack<span>.</span></h2></div><div className="sync-pill"><span className="green-dot"/> SYNC ACTIVE</div></div>
        <div className="player-card">
          <div className="album-wrap">{room.playback.track ? <img src={room.playback.track.thumbnail} alt="" className="album-art"/> : <div className="album-placeholder"><Music2 size={64}/></div>}<div className="art-glow"/></div>
          <div className="track-info"><div className="track-overline">PLAYING FOR EVERYONE</div><h3>{room.playback.track?.title || 'Nothing playing yet'}</h3><p>{room.playback.track?.artist || 'Add a track to get the room started'}</p>
            <div className="progress-row"><span>{formatTime(localPosition)}</span><div className="progress-track"><div style={{width: `${Math.min(100, (localPosition / (localDuration || 1)) * 100)}%`}}/></div><span>{formatTime(localDuration)}</span></div>
            <div className="player-controls"><button className="control-btn" onClick={() => void skipTrack()} disabled={!canControl || !room.queue.length} title="Skip"><SkipForward size={19}/></button><button className="play-btn" onClick={() => void togglePlayback()} disabled={!canControl || !room.playback.track}>{room.playback.playing ? <Pause fill="currentColor" size={21}/> : <Play fill="currentColor" size={21}/>}</button><button className="control-btn" onClick={() => void savePlayback({position: Math.max(0, currentPosition(room.playback) - 10)})} disabled={!canControl || !room.playback.track} title="Back 10 seconds"><ArrowLeft size={18}/></button><span className="control-hint">{canControl ? 'YOU CAN CONTROL PLAYBACK' : 'HOST CONTROLS PLAYBACK'}</span></div>
          </div>
          <div className="youtube-player"><div ref={playerHostRef}/></div>
          {!audioReady && room.playback.track && <button className="audio-overlay" onClick={activateAudio}><Volume2 size={18}/> Tap to enable audio</button>}
        </div>
        <div className="search-section"><div className="section-heading"><div><span className="eyebrow">FIND THE NEXT TRACK</span><h3>Search music</h3></div><span className="powered">POWERED BY YOUTUBE</span></div><form className="search-bar" onSubmit={searchTracks}><Search size={18}/><input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search songs, artists, albums..."/><button disabled={searching || !query.trim()}>{searching ? <Loader2 className="spin"/> : 'Search'}</button></form>
          {error && <p className="error-text">{error}</p>}
          {results.length > 0 && <div className="results-list">{results.map(track => <div className="result-row" key={track.videoId}><img src={track.thumbnail} alt=""/><div className="result-copy"><b>{track.title}</b><small>{track.artist}</small></div><button className="add-btn" onClick={() => void addTrack(track)}><Plus size={16}/> Add</button></div>)}</div>}
        </div>
      </section>
      <aside className="side-column">
        <div className="side-tabs"><button className={mobileTab === 'queue' ? 'active' : ''} onClick={() => setMobileTab('queue')}>UP NEXT <span>{room.queue.length}</span></button><button className={mobileTab === 'people' ? 'active' : ''} onClick={() => setMobileTab('people')}>LISTENERS <span>{participants.length}</span></button></div>
        {mobileTab === 'queue' ? <><div className="queue-list">{room.queue.length ? room.queue.map((item, index) => <div className="queue-row" key={item.id}><span className="queue-number">{String(index + 1).padStart(2,'0')}</span><img src={item.thumbnail} alt=""/><div className="queue-copy"><b>{item.title}</b><small>{item.artist}</small><small className="added-by">Added by {item.addedBy}</small></div>{(item.addedBy === (nickname.trim() || 'Guest') || room.host_id === userId) && <button className="remove-btn" title="Remove from queue" onClick={() => void removeTrack(item.id)}><X size={15}/></button>}</div>) : <div className="empty-state"><Music2 size={25}/><b>The queue is empty</b><span>Search for a track and add it here.</span></div>}</div>
          {room.history.length > 0 && <div className="history-block"><div className="small-heading">RECENTLY PLAYED</div>{room.history.slice(0,4).map((t,i)=><div className="history-row" key={`${t.videoId}-${i}`}><img src={t.thumbnail} alt=""/><div><b>{t.title}</b><small>{t.artist}</small></div></div>)}</div>}</>
        : <div className="people-list">{participants.map(person => <div className="person-row" key={person.user_id}><span className={`person-avatar avatar-${Math.abs(person.nickname.charCodeAt(0) || 0)%4}`}>{person.nickname.charAt(0).toUpperCase()}</span><div><b>{person.nickname} {person.user_id === userId ? '(you)' : ''}</b><small>{person.is_host ? 'Room host' : 'Listening together'}</small></div>{person.is_host && <span className="host-tag">HOST</span>}</div>)}</div>}
        <div className="room-tip"><div className="tip-icon"><Headphones size={18}/></div><div><b>Better together</b><p>Keep this tab open and your sound on. Invite friends to join the same moment.</p></div></div>
      </aside>
    </div>
    <footer className="room-footer"><span>sideplay<span className="brand-dot">.</span></span><span>ROOM {room.code} · {participants.length} LISTENING</span><span>UNOFFICIAL COMMUNITY PROJECT</span></footer>
    {toast && <div className="toast"><Check size={16}/>{toast}</div>}
  </main>
}

function SetupScreen() {
  return <main className="setup-screen"><div className="setup-card"><span className="brand"><span className="brand-icon"><Headphones/></span>sideplay<span className="brand-dot">.</span></span><h1>One quick setup.</h1><p>Connect a free Supabase project to enable real rooms, participants and shared playback.</p><ol><li>Create a project at <a href="https://supabase.com" target="_blank">supabase.com</a>.</li><li>Run the SQL in <code>supabase/schema.sql</code> using the SQL Editor.</li><li>Enable <b>Anonymous Sign-Ins</b> in Authentication → Providers.</li><li>Copy your Project URL and anon key into <code>.env.local</code>.</li><li>Deploy the YouTube search function and set its API key secret (guide in README).</li></ol><p className="setup-note">No paid plan is required for the included small-group setup. YouTube Data API has a free daily quota; some videos may block embedded playback.</p></div></main>
}
