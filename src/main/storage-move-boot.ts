import { app } from 'electron'
import { runPendingStorageMove } from './storage-move'

if (app.requestSingleInstanceLock()) runPendingStorageMove()
