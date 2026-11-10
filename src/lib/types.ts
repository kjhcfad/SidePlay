export type Track = {
  videoId: string
  title: string
  artist: string
  thumbnail: string
  duration?: string
}
export type QueueItem = Track & { id: string; addedBy: string; addedAt: number }
export type Playback = {
  track: Track | null
  playing: boolean
  position: number
  updatedAt: number
  changedBy: string
}
export type Participant = { user_id: string; nickname: string; is_host: boolean; last_seen: string }
export type Room = {
  id: string
  code: string
  host_id: string
  allow_controls: boolean
  playback: Playback
  queue: QueueItem[]
  history: Track[]
}
