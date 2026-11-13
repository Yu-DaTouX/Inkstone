import { forwardRef, type ComponentPropsWithoutRef, type ForwardRefExoticComponent, type RefAttributes } from 'react'
import {
  Alarm as PAlarm,
  Archive as PArchive,
  ArrowBendUpLeft as PArrowBendUpLeft,
  ArrowBendUpRight as PArrowBendUpRight,
  ArrowClockwise as PArrowClockwise,
  ArrowCounterClockwise as PArrowCounterClockwise,
  ArrowDown as PArrowDown,
  ArrowElbowDownLeft as PArrowElbowDownLeft,
  ArrowElbowDownRight as PArrowElbowDownRight,
  ArrowLeft as PArrowLeft,
  ArrowRight as PArrowRight,
  ArrowSquareOut as PArrowSquareOut,
  ArrowUUpLeft as PArrowUUpLeft,
  ArrowUUpRight as PArrowUUpRight,
  ArrowUp as PArrowUp,
  ArrowUpRight as PArrowUpRight,
  ArrowsClockwise as PArrowsClockwise,
  ArrowsIn as PArrowsIn,
  ArrowsInLineVertical as PArrowsInLineVertical,
  ArrowsLeftRight as PArrowsLeftRight,
  ArrowsOut as PArrowsOut,
  ArrowsOutSimple as PArrowsOutSimple,
  Bell as PBell,
  BellSlash as PBellSlash,
  BookOpen as PBookOpen,
  BookmarkSimple as PBookmarkSimple,
  BoxArrowUp as PBoxArrowUp,
  BracketsCurly as PBracketsCurly,
  Brain as PBrain,
  Cards as PCards,
  CaretDown as PCaretDown,
  CaretLeft as PCaretLeft,
  CaretRight as PCaretRight,
  CaretUp as PCaretUp,
  CaretUpDown as PCaretUpDown,
  ChartBar as PChartBar,
  Chat as PChat,
  ChatCenteredDots as PChatCenteredDots,
  ChatCircleDots as PChatCircleDots,
  ChatText as PChatText,
  Check as PCheck,
  CheckCircle as PCheckCircle,
  Circle as PCircle,
  CircleDashed as PCircleDashed,
  CircleNotch as PCircleNotch,
  Clock as PClock,
  CloudArrowDown as PCloudArrowDown,
  CloudArrowUp as PCloudArrowUp,
  Code as PCode,
  CodeSimple as PCodeSimple,
  Columns as PColumns,
  Copy as PCopy,
  CornersOut as PCornersOut,
  Crosshair as PCrosshair,
  Cursor as PCursor,
  CursorClick as PCursorClick,
  DeviceMobile as PDeviceMobile,
  DeviceTablet as PDeviceTablet,
  Devices as PDevices,
  DotsSixVertical as PDotsSixVertical,
  DotsThree as PDotsThree,
  DotsThreeCircle as PDotsThreeCircle,
  DotsThreeVertical as PDotsThreeVertical,
  DownloadSimple as PDownloadSimple,
  Envelope as PEnvelope,
  EnvelopeOpen as PEnvelopeOpen,
  Eye as PEye,
  File as PFile,
  FileCode as PFileCode,
  FileImage as PFileImage,
  FileLock as PFileLock,
  FileText as PFileText,
  FileX as PFileX,
  FileZip as PFileZip,
  Files as PFiles,
  FilmSlate as PFilmSlate,
  FilmStrip as PFilmStrip,
  Flask as PFlask,
  Folder as PFolder,
  FolderMinus as PFolderMinus,
  FolderOpen as PFolderOpen,
  FolderPlus as PFolderPlus,
  FolderSimple as PFolderSimple,
  Folders as PFolders,
  FunnelSimple as PFunnelSimple,
  Gauge as PGauge,
  GearSix as PGearSix,
  GitBranch as PGitBranch,
  GitCommit as PGitCommit,
  GitDiff as PGitDiff,
  GitMerge as PGitMerge,
  GitPullRequest as PGitPullRequest,
  Globe as PGlobe,
  GlobeSimple as PGlobeSimple,
  Hand as PHand,
  HardDrive as PHardDrive,
  HardDrives as PHardDrives,
  Hash as PHash,
  Hourglass as PHourglass,
  Image as PImage,
  ImageBroken as PImageBroken,
  ImageSquare as PImageSquare,
  Info as PInfo,
  Key as PKey,
  Keyboard as PKeyboard,
  Lightning as PLightning,
  Link as PLink,
  LinkBreak as PLinkBreak,
  LinkSimple as PLinkSimple,
  List as PList,
  ListMagnifyingGlass as PListMagnifyingGlass,
  ListPlus as PListPlus,
  Lock as PLock,
  MagnifyingGlass as PMagnifyingGlass,
  MagnifyingGlassMinus as PMagnifyingGlassMinus,
  MagnifyingGlassPlus as PMagnifyingGlassPlus,
  Microphone as PMicrophone,
  Minus as PMinus,
  Monitor as PMonitor,
  Moon as PMoon,
  NotePencil as PNotePencil,
  Package as PPackage,
  Palette as PPalette,
  PaperPlaneRight as PPaperPlaneRight,
  Paperclip as PPaperclip,
  Pause as PPause,
  PauseCircle as PPauseCircle,
  PencilLine as PPencilLine,
  PencilSimple as PPencilSimple,
  PictureInPicture as PPictureInPicture,
  Play as PPlay,
  Plug as PPlug,
  Plugs as PPlugs,
  Plus as PPlus,
  Power as PPower,
  Prohibit as PProhibit,
  PushPin as PPushPin,
  PushPinSlash as PPushPinSlash,
  PuzzlePiece as PPuzzlePiece,
  Question as PQuestion,
  Record as PRecord,
  Robot as PRobot,
  Rows as PRows,
  Scroll as PScroll,
  Selection as PSelection,
  Shield as PShield,
  ShieldCheck as PShieldCheck,
  ShieldSlash as PShieldSlash,
  ShieldWarning as PShieldWarning,
  SidebarSimple as PSidebarSimple,
  SignIn as PSignIn,
  SkipBack as PSkipBack,
  SkipForward as PSkipForward,
  SlidersHorizontal as PSlidersHorizontal,
  SortAscending as PSortAscending,
  SortDescending as PSortDescending,
  Sparkle as PSparkle,
  SpeakerHigh as PSpeakerHigh,
  SpinnerGap as PSpinnerGap,
  Square as PSquare,
  SquareSplitHorizontal as PSquareSplitHorizontal,
  SquaresFour as PSquaresFour,
  Stack as PStack,
  Star as PStar,
  StopCircle as PStopCircle,
  Sun as PSun,
  Swap as PSwap,
  Tag as PTag,
  Terminal as PTerminal,
  TerminalWindow as PTerminalWindow,
  TextT as PTextT,
  Ticket as PTicket,
  Trash as PTrash,
  Tray as PTray,
  TreeView as PTreeView,
  TrendDown as PTrendDown,
  TrendUp as PTrendUp,
  UploadSimple as PUploadSimple,
  User as PUser,
  Users as PUsers,
  Warning as PWarning,
  WarningCircle as PWarningCircle,
  WarningOctagon as PWarningOctagon,
  Wrench as PWrench,
  X as PX,
  XCircle as PXCircle,
  XSquare as PXSquare
} from '@phosphor-icons/react'
import type { Icon as PhosphorIcon, IconWeight } from '@phosphor-icons/react'
import './icons.css'

export interface IconProps extends Omit<ComponentPropsWithoutRef<'svg'>, 'ref'> {
  size?: number | string
  strokeWidth?: number | string
  absoluteStrokeWidth?: boolean
  weight?: IconWeight
  mirrored?: boolean
}

export type IconComponent = ForwardRefExoticComponent<IconProps & RefAttributes<SVGSVGElement>>
export type LucideIcon = IconComponent

function icon(Source: PhosphorIcon, name: string, fixed?: { mirrored?: boolean }): IconComponent {
  const Component = forwardRef<SVGSVGElement, IconProps>(function YanIcon({ size = 24, strokeWidth: _stroke, absoluteStrokeWidth: _absolute, weight, mirrored, fill, className, ...rest }, ref) {
    const resolved = weight ?? (fill && fill !== 'none' ? 'fill' : 'regular')
    return <Source ref={ref} size={size} weight={resolved} mirrored={mirrored ?? fixed?.mirrored} className={className ? `ui-icon ${className}` : 'ui-icon'} data-icon={name} {...rest} />
  })
  Component.displayName = name
  return Component
}

export const AlarmClock = icon(PAlarm, 'AlarmClock')
export const AlarmClockOff = icon(PBellSlash, 'AlarmClockOff')
export const AlertCircle = icon(PWarningCircle, 'AlertCircle')
export const AlertTriangle = icon(PWarning, 'AlertTriangle')
export const Archive = icon(PArchive, 'Archive')
export const ArchiveRestore = icon(PBoxArrowUp, 'ArchiveRestore')
export const ArrowDown = icon(PArrowDown, 'ArrowDown')
export const ArrowDownWideNarrow = icon(PSortDescending, 'ArrowDownWideNarrow')
export const ArrowLeft = icon(PArrowLeft, 'ArrowLeft')
export const ArrowRight = icon(PArrowRight, 'ArrowRight')
export const ArrowRightLeft = icon(PArrowsLeftRight, 'ArrowRightLeft')
export const ArrowUp = icon(PArrowUp, 'ArrowUp')
export const ArrowUpIcon = icon(PArrowUp, 'ArrowUpIcon')
export const ArrowUpNarrowWide = icon(PSortAscending, 'ArrowUpNarrowWide')
export const ArrowUpRight = icon(PArrowUpRight, 'ArrowUpRight')
export const Ban = icon(PProhibit, 'Ban')
export const BarChart3 = icon(PChartBar, 'BarChart3')
export const Bell = icon(PBell, 'Bell')
export const BookOpen = icon(PBookOpen, 'BookOpen')
export const BookmarkIcon = icon(PBookmarkSimple, 'BookmarkIcon')
export const Bot = icon(PRobot, 'Bot')
export const Braces = icon(PBracketsCurly, 'Braces')
export const Brain = icon(PBrain, 'Brain')
export const Check = icon(PCheck, 'Check')
export const CheckCircle2 = icon(PCheckCircle, 'CheckCircle2')
export const CheckIcon = icon(PCheck, 'CheckIcon')
export const ChevronDown = icon(PCaretDown, 'ChevronDown')
export const ChevronDownIcon = icon(PCaretDown, 'ChevronDownIcon')
export const ChevronLeft = icon(PCaretLeft, 'ChevronLeft')
export const ChevronRight = icon(PCaretRight, 'ChevronRight')
export const ChevronRightIcon = icon(PCaretRight, 'ChevronRightIcon')
export const ChevronUp = icon(PCaretUp, 'ChevronUp')
export const ChevronsDownUp = icon(PArrowsInLineVertical, 'ChevronsDownUp')
export const ChevronsUpDown = icon(PCaretUpDown, 'ChevronsUpDown')
export const Circle = icon(PCircle, 'Circle')
export const CircleAlert = icon(PWarningCircle, 'CircleAlert')
export const CircleAlertIcon = icon(PWarningCircle, 'CircleAlertIcon')
export const CircleCheck = icon(PCheckCircle, 'CircleCheck')
export const CircleDashed = icon(PCircleDashed, 'CircleDashed')
export const CircleDot = icon(PRecord, 'CircleDot')
export const CircleDotDashed = icon(PCircleNotch, 'CircleDotDashed')
export const CircleEllipsis = icon(PDotsThreeCircle, 'CircleEllipsis')
export const CircleHelp = icon(PQuestion, 'CircleHelp')
export const CirclePause = icon(PPauseCircle, 'CirclePause')
export const CircleStop = icon(PStopCircle, 'CircleStop')
export const CircleX = icon(PXCircle, 'CircleX')
export const Clapperboard = icon(PFilmSlate, 'Clapperboard')
export const Clock = icon(PClock, 'Clock')
export const CloudDownload = icon(PCloudArrowDown, 'CloudDownload')
export const CloudUpload = icon(PCloudArrowUp, 'CloudUpload')
export const Code = icon(PCode, 'Code')
export const Code2 = icon(PCodeSimple, 'Code2')
export const Columns2 = icon(PSquareSplitHorizontal, 'Columns2')
export const Columns3 = icon(PColumns, 'Columns3')
export const Copy = icon(PCopy, 'Copy')
export const CornerDownRight = icon(PArrowElbowDownRight, 'CornerDownRight')
export const CornerUpRight = icon(PArrowBendUpRight, 'CornerUpRight')
export const CornerUpRightIcon = icon(PArrowBendUpRight, 'CornerUpRightIcon')
export const Crosshair = icon(PCrosshair, 'Crosshair')
export const Download = icon(PDownloadSimple, 'Download')
export const EllipsisIcon = icon(PDotsThree, 'EllipsisIcon')
export const EllipsisVertical = icon(PDotsThreeVertical, 'EllipsisVertical')
export const EllipsisVerticalIcon = icon(PDotsThreeVertical, 'EllipsisVerticalIcon')
export const ExternalLink = icon(PArrowSquareOut, 'ExternalLink')
export const Eye = icon(PEye, 'Eye')
export const File = icon(PFile, 'File')
export const FileArchive = icon(PFileZip, 'FileArchive')
export const FileCode = icon(PFileCode, 'FileCode')
export const FileCode2 = icon(PFileCode, 'FileCode2')
export const FileDiff = icon(PGitDiff, 'FileDiff')
export const FileIcon = icon(PFile, 'FileIcon')
export const FileImage = icon(PFileImage, 'FileImage')
export const FileLock2 = icon(PFileLock, 'FileLock2')
export const FileText = icon(PFileText, 'FileText')
export const FileTextIcon = icon(PFileText, 'FileTextIcon')
export const FileWarning = icon(PFileX, 'FileWarning')
export const Files = icon(PFiles, 'Files')
export const Film = icon(PFilmStrip, 'Film')
export const FlaskConical = icon(PFlask, 'FlaskConical')
export const Folder = icon(PFolder, 'Folder')
export const FolderCodeIcon = icon(PFolderSimple, 'FolderCodeIcon')
export const FolderCog = icon(PFolders, 'FolderCog')
export const FolderGit2 = icon(PFolderSimple, 'FolderGit2')
export const FolderGit2Icon = icon(PFolderSimple, 'FolderGit2Icon')
export const FolderInput = icon(PFolderOpen, 'FolderInput')
export const FolderMinus = icon(PFolderMinus, 'FolderMinus')
export const FolderOpen = icon(PFolderOpen, 'FolderOpen')
export const FolderPlus = icon(PFolderPlus, 'FolderPlus')
export const Gauge = icon(PGauge, 'Gauge')
export const GaugeIcon = icon(PGauge, 'GaugeIcon')
export const GitBranch = icon(PGitBranch, 'GitBranch')
export const GitCommitHorizontal = icon(PGitCommit, 'GitCommitHorizontal')
export const GitMerge = icon(PGitMerge, 'GitMerge')
export const GitMergeIcon = icon(PGitMerge, 'GitMergeIcon')
export const GitPullRequest = icon(PGitPullRequest, 'GitPullRequest')
export const GitPullRequestArrowIcon = icon(PGitPullRequest, 'GitPullRequestArrowIcon')
export const GitPullRequestClosedIcon = icon(PGitPullRequest, 'GitPullRequestClosedIcon')
export const GitPullRequestCreate = icon(PGitPullRequest, 'GitPullRequestCreate')
export const GitPullRequestDraftIcon = icon(PGitPullRequest, 'GitPullRequestDraftIcon')
export const Globe = icon(PGlobe, 'Globe')
export const Globe2 = icon(PGlobeSimple, 'Globe2')
export const GripVertical = icon(PDotsSixVertical, 'GripVertical')
export const Hand = icon(PHand, 'Hand')
export const HardDrive = icon(PHardDrive, 'HardDrive')
export const Hash = icon(PHash, 'Hash')
export const Hourglass = icon(PHourglass, 'Hourglass')
export const Image = icon(PImage, 'Image')
export const ImageDown = icon(PDownloadSimple, 'ImageDown')
export const ImageIcon = icon(PImage, 'ImageIcon')
export const ImageOff = icon(PImageBroken, 'ImageOff')
export const ImagePlus = icon(PImageSquare, 'ImagePlus')
export const Inbox = icon(PTray, 'Inbox')
export const Info = icon(PInfo, 'Info')
export const KeyRound = icon(PKey, 'KeyRound')
export const Keyboard = icon(PKeyboard, 'Keyboard')
export const Layers = icon(PStack, 'Layers')
export const LayersIcon = icon(PStack, 'LayersIcon')
export const LayoutGrid = icon(PSquaresFour, 'LayoutGrid')
export const Link = icon(PLink, 'Link')
export const Link2 = icon(PLinkSimple, 'Link2')
export const Link2Icon = icon(PLinkSimple, 'Link2Icon')
export const List = icon(PList, 'List')
export const ListFilter = icon(PFunnelSimple, 'ListFilter')
export const ListPlus = icon(PListPlus, 'ListPlus')
export const ListTree = icon(PTreeView, 'ListTree')
export const Loader = icon(PSpinnerGap, 'Loader')
export const LoaderCircle = icon(PCircleNotch, 'LoaderCircle')
export const Lock = icon(PLock, 'Lock')
export const LogIn = icon(PSignIn, 'LogIn')
export const Mail = icon(PEnvelope, 'Mail')
export const MailOpen = icon(PEnvelopeOpen, 'MailOpen')
export const Maximize = icon(PCornersOut, 'Maximize')
export const Maximize2 = icon(PArrowsOut, 'Maximize2')
export const MessageCircleQuestion = icon(PChatCircleDots, 'MessageCircleQuestion')
export const MessageSquare = icon(PChat, 'MessageSquare')
export const MessageSquarePlus = icon(PChatCenteredDots, 'MessageSquarePlus')
export const MessageSquareReply = icon(PArrowBendUpLeft, 'MessageSquareReply')
export const MessageSquareText = icon(PChatText, 'MessageSquareText')
export const Mic = icon(PMicrophone, 'Mic')
export const Minimize2 = icon(PArrowsIn, 'Minimize2')
export const Minimize2Icon = icon(PArrowsIn, 'Minimize2Icon')
export const Minus = icon(PMinus, 'Minus')
export const Monitor = icon(PMonitor, 'Monitor')
export const MonitorSmartphone = icon(PDevices, 'MonitorSmartphone')
export const Moon = icon(PMoon, 'Moon')
export const MoreHorizontal = icon(PDotsThree, 'MoreHorizontal')
export const MousePointer2 = icon(PCursor, 'MousePointer2')
export const MousePointerClick = icon(PCursorClick, 'MousePointerClick')
export const MoveDiagonal2 = icon(PArrowsOutSimple, 'MoveDiagonal2')
export const OctagonAlert = icon(PWarningOctagon, 'OctagonAlert')
export const Package = icon(PPackage, 'Package')
export const Palette = icon(PPalette, 'Palette')
export const PanelLeft = icon(PSidebarSimple, 'PanelLeft')
export const PanelLeftClose = icon(PSidebarSimple, 'PanelLeftClose')
export const PanelRight = icon(PSidebarSimple, 'PanelRight', { mirrored: true })
export const PanelRightClose = icon(PSidebarSimple, 'PanelRightClose', { mirrored: true })
export const PaperclipIcon = icon(PPaperclip, 'PaperclipIcon')
export const Pause = icon(PPause, 'Pause')
export const PenLine = icon(PPencilLine, 'PenLine')
export const Pencil = icon(PPencilSimple, 'Pencil')
export const PencilIcon = icon(PPencilSimple, 'PencilIcon')
export const PencilLine = icon(PPencilLine, 'PencilLine')
export const PictureInPicture2 = icon(PPictureInPicture, 'PictureInPicture2')
export const Pin = icon(PPushPin, 'Pin')
export const PinOff = icon(PPushPinSlash, 'PinOff')
export const Play = icon(PPlay, 'Play')
export const Plug = icon(PPlug, 'Plug')
export const Plus = icon(PPlus, 'Plus')
export const Power = icon(PPower, 'Power')
export const Puzzle = icon(PPuzzlePiece, 'Puzzle')
export const Redo2 = icon(PArrowUUpRight, 'Redo2')
export const RefreshCw = icon(PArrowsClockwise, 'RefreshCw')
export const Replace = icon(PSwap, 'Replace')
export const RotateCcw = icon(PArrowCounterClockwise, 'RotateCcw')
export const RotateCw = icon(PArrowClockwise, 'RotateCw')
export const Rows3 = icon(PRows, 'Rows3')
export const ScrollText = icon(PScroll, 'ScrollText')
export const Search = icon(PMagnifyingGlass, 'Search')
export const SearchIcon = icon(PMagnifyingGlass, 'SearchIcon')
export const SearchX = icon(PMagnifyingGlassMinus, 'SearchX')
export const SendHorizontal = icon(PPaperPlaneRight, 'SendHorizontal')
export const Server = icon(PHardDrives, 'Server')
export const Settings = icon(PGearSix, 'Settings')
export const Settings2 = icon(PSlidersHorizontal, 'Settings2')
export const Shield = icon(PShield, 'Shield')
export const ShieldAlert = icon(PShieldWarning, 'ShieldAlert')
export const ShieldCheck = icon(PShieldCheck, 'ShieldCheck')
export const ShieldCheckIcon = icon(PShieldCheck, 'ShieldCheckIcon')
export const ShieldOffIcon = icon(PShieldSlash, 'ShieldOffIcon')
export const ShieldQuestion = icon(PShield, 'ShieldQuestion')
export const SkipBack = icon(PSkipBack, 'SkipBack')
export const SkipForward = icon(PSkipForward, 'SkipForward')
export const SlidersHorizontal = icon(PSlidersHorizontal, 'SlidersHorizontal')
export const Smartphone = icon(PDeviceMobile, 'Smartphone')
export const Sparkles = icon(PSparkle, 'Sparkles')
export const SparklesIcon = icon(PSparkle, 'SparklesIcon')
export const Square = icon(PSquare, 'Square')
export const SquareDashedMousePointer = icon(PSelection, 'SquareDashedMousePointer')
export const SquarePen = icon(PNotePencil, 'SquarePen')
export const SquarePenIcon = icon(PNotePencil, 'SquarePenIcon')
export const SquareStack = icon(PCards, 'SquareStack')
export const SquareTerminal = icon(PTerminalWindow, 'SquareTerminal')
export const SquareX = icon(PXSquare, 'SquareX')
export const Star = icon(PStar, 'Star')
export const StarIcon = icon(PStar, 'StarIcon')
export const Sun = icon(PSun, 'Sun')
export const Tablet = icon(PDeviceTablet, 'Tablet')
export const Tag = icon(PTag, 'Tag')
export const Terminal = icon(PTerminal, 'Terminal')
export const TerminalSquare = icon(PTerminalWindow, 'TerminalSquare')
export const TextSearch = icon(PListMagnifyingGlass, 'TextSearch')
export const Ticket = icon(PTicket, 'Ticket')
export const Trash2 = icon(PTrash, 'Trash2')
export const TrendingDown = icon(PTrendDown, 'TrendingDown')
export const TrendingUp = icon(PTrendUp, 'TrendingUp')
export const TriangleAlert = icon(PWarning, 'TriangleAlert')
export const TriangleAlertIcon = icon(PWarning, 'TriangleAlertIcon')
export const Type = icon(PTextT, 'Type')
export const Undo2 = icon(PArrowUUpLeft, 'Undo2')
export const Undo2Icon = icon(PArrowUUpLeft, 'Undo2Icon')
export const Unlink2Icon = icon(PLinkBreak, 'Unlink2Icon')
export const Unplug = icon(PPlugs, 'Unplug')
export const Upload = icon(PUploadSimple, 'Upload')
export const UserRound = icon(PUser, 'UserRound')
export const Users = icon(PUsers, 'Users')
export const Volume2 = icon(PSpeakerHigh, 'Volume2')
export const WrapText = icon(PArrowElbowDownLeft, 'WrapText')
export const Wrench = icon(PWrench, 'Wrench')
export const X = icon(PX, 'X')
export const XIcon = icon(PX, 'XIcon')
export const ZapIcon = icon(PLightning, 'ZapIcon')
export const ZoomIn = icon(PMagnifyingGlassPlus, 'ZoomIn')
export const ZoomOut = icon(PMagnifyingGlassMinus, 'ZoomOut')
