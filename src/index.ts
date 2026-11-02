// author: kodeholic (powered by Claude)
// spec: v1.2 @d626fda · SDK:RULE-API-SURFACE 얇은 표면 · SDK:RULE-API-HANDLES · model: claude-opus-5-5
// OxLensClient 는 형만 내보낸다 — 만드는 길은 createClient() 하나다(SDK:RULE-API-HANDLES 유일한 생성 경로)
export { createClient, Session, Media, Devices, Diagnostics } from './api/client.js'
export type { OxLensClient, RoomPreview, RoomInfo } from './api/client.js'
export { Room, Ptt, LocalTrack, RemoteTrack, RoomAudio } from './api/handles.js'
export type { PttState } from './api/handles.js'
export { OxLensError } from './api/errors.js'
export type { ClientOptions } from './domain/defaults.js'
export type { SessionInfo, SessionState, Health, Quality, Transition } from './domain/ses/core.js'
export type { LinkInfo, LinkState } from './domain/link/core.js'
export type { Participant, Permission, ParticipantType } from './domain/room/store.js'
export type { RemoteInfo } from './domain/trk/remote.js'
export type { TrackOptions, LocalState, Owner, EndReason, Profile } from './domain/pub/local.js'
export type { Phase, LastEnd, ArmingStage, PressSource } from './domain/flr/core.js'
