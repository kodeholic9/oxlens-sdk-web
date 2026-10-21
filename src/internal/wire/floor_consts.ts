// author: kodeholic (powered by Claude)
// spec: context/spec/pilot/floor/ts — 생성 파일(gen/consts.py) · 손으로 고치지 않는다

export const Timers = {
  T101_MS: 500,
  T100_MS: 500,
  T104_MS: 500,
  T132_MS: 2000,
  T1_MS: 4000,
  T1Max_MS: 6000,
  T2_MS: 30000,
  T3_MS: 3000,
  T7_MS: 1000,
  T8_MS: 1000,
  T20_MS: 1000,
  T9_MS: 3000,
  T21_MS: 1000,
  C101: 3,
  C100: 3,
  C104: 3,
  C7: 10,
  C8: 3,
  C20: 3,
  C21: 3,
} as const
export const Msg = {
  REQUEST: 0,
  GRANTED: 1,
  TAKEN: 2,
  DENY: 3,
  RELEASE: 4,
  IDLE: 5,
  REVOKE: 6,
  QPOS_REQ: 8,
  QINFO: 9,
  ACK: 10,
} as const
export const Tlv = {
  PRIORITY: 0,
  DURATION: 1,
  CAUSE: 2,
  QINFO: 3,
  SPEAKER: 4,
  SEQ: 8,
  ACKTYPE: 12,
  PREV: 26,
  REASON: 27,
  ROOM: 29,
} as const
export const Deny = {
  ONLY_ONE: 3,
  RETRY_AFTER: 4,
  RECV_ONLY: 5,
  QUEUE_FULL: 7,
  NOT_PUBROOM: 101,
  NO_PERMISSION: 102,
  OTHER_REASON: 255,
} as const
export const Revoke = {
  TOO_LONG: 2,
  NO_PERMISSION: 3,
  PREEMPTED: 4,
} as const
export const QPos = {
  NOT_IN_QUEUE: 254,
  UNKNOWN: 255,
} as const
export const SEQ_WRAP = 65536
