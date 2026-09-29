/**
 * 必须是 main/index.ts 的第一个 import：在任何模块打开数据目录里的文件之前，
 * 执行设置页登记的数据目录迁移（见 storage-move.ts）。
 *
 * 迁移只允许由持有单实例锁的进程执行：第二个实例（重复双击、launch 与 dev 并存）
 * 拿不到锁，会在 index.ts 里退出，不能在退出前和第一个实例一起搬同一个目录。
 * `requestSingleInstanceLock` 在同一进程里重复调用会返回 true，index.ts 的那次调用不受影响。
 */
import { app } from 'electron'
import { runPendingStorageMove } from './storage-move'

if (app.requestSingleInstanceLock()) runPendingStorageMove()
