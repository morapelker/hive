import { Copy, Check, FolderOpen, GitBranch, Terminal, Code } from 'lucide-react'
import { fileManagerName } from '@/lib/platform'
import { useState, useCallback, useEffect } from 'react'
import { Button } from '@/components/ui/button'
import { useWorktreeStore } from '@/stores/useWorktreeStore'
import { useConnectionStore } from '@/stores/useConnectionStore'
import { useSettingsStore, type EditorOption, type TerminalOption } from '@/stores/useSettingsStore'
import { useProjectStore } from '@/stores/useProjectStore'

function CursorIcon({ className }: { className?: string }): React.JSX.Element {
  return (
    <svg viewBox="0 0 466.73 532.09" className={className} fill="currentColor">
      <path d="M457.43,125.94L244.42,2.96c-6.84-3.95-15.28-3.95-22.12,0L9.3,125.94c-5.75,3.32-9.3,9.46-9.3,16.11v247.99c0,6.65,3.55,12.79,9.3,16.11l213.01,122.98c6.84,3.95,15.28,3.95,22.12,0l213.01-122.98c5.75-3.32,9.3-9.46,9.3-16.11v-247.99c0-6.65-3.55-12.79-9.3-16.11h-.01ZM444.05,151.99l-205.63,356.16c-1.39,2.4-5.06,1.42-5.06-1.36v-233.21c0-4.66-2.49-8.97-6.53-11.31L24.87,145.67c-2.4-1.39-1.42-5.06,1.36-5.06h411.26c5.84,0,9.49,6.33,6.57,11.39h-.01Z" />
    </svg>
  )
}

function GhosttyIcon({ className }: { className?: string }): React.JSX.Element {
  return (
    <svg viewBox="0 0 27 32" className={className} fill="none">
      <path
        fill="#3551F3"
        d="M20.395 32a6.35 6.35 0 0 1-3.516-1.067A6.355 6.355 0 0 1 13.362 32c-1.249 0-2.48-.375-3.516-1.067A6.265 6.265 0 0 1 6.372 32h-.038a6.255 6.255 0 0 1-4.5-1.906 6.377 6.377 0 0 1-1.836-4.482v-12.25C0 5.995 5.994 0 13.362 0c7.369 0 13.363 5.994 13.363 13.363v12.253c0 3.393-2.626 6.192-5.978 6.375-.117.007-.234.009-.352.009Z"
      />
      <path
        fill="#000"
        d="M20.395 30.593a4.932 4.932 0 0 1-3.08-1.083.656.656 0 0 0-.42-.145.784.784 0 0 0-.487.176 4.939 4.939 0 0 1-3.046 1.055 4.939 4.939 0 0 1-3.045-1.055.751.751 0 0 0-.942 0 4.883 4.883 0 0 1-3.01 1.055h-.033a4.852 4.852 0 0 1-3.49-1.482 4.982 4.982 0 0 1-1.436-3.498V13.367c0-6.597 5.364-11.96 11.957-11.96 6.592 0 11.956 5.363 11.956 11.956v12.253c0 2.645-2.042 4.827-4.65 4.97a5.342 5.342 0 0 1-.274.007Z"
      />
      <path
        fill="#fff"
        d="M23.912 13.363v12.253c0 1.876-1.447 3.463-3.32 3.566a3.503 3.503 0 0 1-2.398-.769c-.778-.626-1.873-.598-2.658.021a3.5 3.5 0 0 1-2.176.753 3.494 3.494 0 0 1-2.173-.753 2.153 2.153 0 0 0-2.684 0 3.498 3.498 0 0 1-2.15.753c-1.948.014-3.54-1.627-3.54-3.575v-12.25c0-5.825 4.724-10.549 10.55-10.549 5.825 0 10.549 4.724 10.549 10.55Z"
      />
      <path
        fill="#000"
        d="m11.28 12.437-3.93-2.27a1.072 1.072 0 0 0-1.463.392 1.072 1.072 0 0 0 .391 1.463l2.326 1.343-2.326 1.343a1.072 1.072 0 0 0 1.071 1.855l3.932-2.27a1.071 1.071 0 0 0 0-1.854v-.002ZM20.182 12.291h-5.164a1.071 1.071 0 1 0 0 2.143h5.164a1.071 1.071 0 1 0 0-2.143Z"
      />
    </svg>
  )
}

function WarpIcon({ className }: { className?: string }): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="currentColor">
      <path d="M12 0C5.373 0 0 5.373 0 12s5.373 12 12 12 12-5.373 12-12S18.627 0 12 0zm5.568 8.16a.554.554 0 0 1-.554.553h-5.46l-2.14 6.574a.554.554 0 0 1-1.054-.343l2.278-6.998a.554.554 0 0 1 .527-.382h5.849c.306 0 .554.29.554.596zm-4.283 7.68a.554.554 0 0 1-.527.382H6.91a.554.554 0 0 1 0-1.107h5.46l2.14-6.574a.554.554 0 0 1 1.054.343l-2.278 6.998z" />
    </svg>
  )
}

function AndroidStudioIcon({ className }: { className?: string }): React.JSX.Element {
  return (
    <svg
      viewBox="0 0 512 512"
      className={className}
      fillRule="evenodd"
      clipRule="evenodd"
      strokeLinejoin="round"
      strokeMiterlimit={2}
    >
      <g fillRule="nonzero">
        <path
          d="M199.101 489.435c-7.912-1.88-14.536-6.268-23.804-15.776-15.48-15.88-28.048-22.496-49.884-26.252-22.656-3.9-32.72-12.324-38.772-32.432-7.472-24.828-15.28-36.716-32.436-49.388-19.464-14.376-24.456-27.052-19.708-50.028 4.4-21.276 2.716-36.404-6.22-55.856-10.664-23.204-9.348-35.604 5.796-54.616 13.884-17.432 18.24-28.952 20.32-53.728 2.096-25.004 9.052-35.26 29.54-43.56 17.096-6.928 31.724-18.956 39.832-32.752 9.376-15.956 10.744-17.784 16.556-22.12 9.376-6.996 16.956-8.932 31.392-8.028 25.08 1.572 38.52-1.44 55.36-12.404 21.956-14.292 35.272-14.292 57.228 0 16.844 10.964 30.284 13.976 55.36 12.404 23.716-1.488 33.584 4.736 48.04 30.308 7.164 12.668 21.804 25 37.832 31.86 22.824 9.768 29.456 18.684 31.14 41.852 1.824 25.092 6.968 39.12 20.596 56.168 15.176 18.976 16.5 31.388 5.828 54.616-8.932 19.452-10.62 34.58-6.22 55.856 4.752 22.976-.244 35.652-19.704 50.028-17.156 12.672-24.964 24.56-32.436 49.388-6.052 20.108-16.12 28.532-38.772 32.432-21.888 3.764-34.464 10.4-49.888 26.304-17.096 17.632-29.352 20.54-53.252 12.64-19.548-6.464-34.6-6.492-54.068-.1-13.64 4.476-20.908 5.256-29.656 3.184z"
          fill="#fff"
        />
        <path
          d="M339.709 236.271c-1.476-3.016-.212-6.628 2.8-8.104 3.012-1.476 6.628-.212 8.104 2.8 1.476 3.012.212 6.628-2.8 8.104-3.012 1.476-6.628.212-8.104-2.8zm29.308 60.24c-1.476-3.012-.212-6.628 2.8-8.104 3.012-1.476 6.628-.208 8.104 2.804 1.476 3.012.212 6.624-2.8 8.1s-6.628.212-8.104-2.8zm2.56-78.164c-19.276-13.764-44.428-17.32-67.712-8.312l63.644 130.872c21.448-12.74 34.16-34.756 35.244-58.404l24.156 1.72a2.507 2.507 0 002.68-2.352 2.503 2.503 0 00-2.348-2.68l-24.46-1.748c-.24-10.3-2.708-20.812-7.62-30.932-4.908-10.092-11.656-18.524-19.608-25.092l13.736-20.332a2.515 2.515 0 00-4.156-2.832l-13.556 20.064"
          fill="#3ddc84"
        />
        <path
          d="M312.901 267.623c-17.952 8.676-37.26 13.072-57.38 13.072a132.032 132.032 0 01-110.512-59.636c-1.896-2.892-5.812-3.584-8.612-1.536l-23.104 17.016c-2.62 1.928-3.224 5.604-1.388 8.316a172.751 172.751 0 00143.616 76.564c26.296 0 51.568-5.752 75.092-17.108l-17.712-36.688zM242.813 122.835h25v-27.62c0-6.9-5.604-12.5-12.5-12.5-6.9 0-12.5 5.6-12.5 12.5v27.62z"
          fill="#4285f4"
        />
        <path
          d="M222.781 176.751l-85.936 176.868a29.306 29.306 0 00-2.952 12.228l-.512 23.164c-.12 5.996 6.808 9.368 11.448 5.572l17.892-14.7a29.343 29.343 0 007.8-9.876l84.7-174.372-32.412-18.856-.028-.028zM376.757 365.819c-.088-4.248-1.112-8.404-2.952-12.228l-85.932-176.872-32.412 18.916 84.7 174.308a29.645 29.645 0 007.8 9.88l17.892 14.7c4.64 3.796 11.596.42 11.448-5.572l-.512-23.164-.032.032z"
          fill="#4285f4"
        />
        <path
          d="M255.309 120.635c-20.692 0-37.5 16.84-37.5 37.5 0 20.664 16.84 37.5 37.5 37.5 20.664 0 37.5-16.836 37.5-37.5 0-20.66-16.836-37.5-37.5-37.5zm0 58.132c-11.352 0-20.632-9.244-20.632-20.632 0-11.384 9.248-20.632 20.632-20.632 11.388 0 20.636 9.248 20.636 20.632 0 11.388-9.248 20.632-20.636 20.632z"
          fill="#073042"
        />
      </g>
    </svg>
  )
}

function XcodeIcon({ className }: { className?: string }): React.JSX.Element {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" className={className}>
      <linearGradient
        id="xcode-a"
        gradientUnits="userSpaceOnUse"
        x1="63.947"
        y1="114.165"
        x2="63.947"
        y2="13.784"
      >
        <stop offset="0" stopColor="#1578e4" />
        <stop offset="1" stopColor="#00c3f2" />
      </linearGradient>
      <path
        d="M35.7 13.8h56.5c12.1 0 21.9 9.8 21.9 21.9v56.5c0 12.1-9.8 21.9-21.9 21.9H35.7c-12.1 0-21.9-9.8-21.9-21.9V35.7c0-12.1 9.8-21.9 21.9-21.9z"
        fill="url(#xcode-a)"
      />
      <path
        fill="#FFF"
        d="M90.5 19.2H37.4c-10.1 0-18.3 8.2-18.3 18.3v53.1c0 10.1 8.2 18.3 18.3 18.3h53.1c10.1 0 18.3-8.2 18.3-18.3V37.4c0-10.1-8.2-18.2-18.3-18.2zm16.8 71.6c0 9.2-7.4 16.6-16.6 16.6H37.2c-9.1 0-16.6-7.4-16.6-16.6V37.2c0-9.2 7.4-16.6 16.6-16.6h53.6c9.1 0 16.6 7.4 16.6 16.6v53.6z"
      />
      <path
        d="M64.1 22.8c-22.6 0-41 18.4-41 41s18.4 41 41 41c22.7 0 41-18.4 41-41s-18.4-41-41-41zm0 81.4c-22.3 0-40.4-18.1-40.4-40.4s18.1-40.4 40.4-40.4c22.3 0 40.4 18.1 40.4 40.4s-18.1 40.4-40.4 40.4z"
        fill="#69c5f3"
      />
      <path
        d="M64.1 31.2c-18.1 0-32.7 14.6-32.7 32.7S46 96.5 64.1 96.5s32.7-14.6 32.7-32.7-14.7-32.6-32.7-32.6zm0 64.6c-17.7 0-32-14.3-32-32s14.3-32 32-32 32 14.3 32 32-14.4 32-32 32z"
        fill="#68c5f4"
      />
      <path
        fill="#FFF"
        d="M32.8 71.3h62.4c2.6 0 4.6 2.1 4.6 4.6 0 2.6-2.1 4.6-4.6 4.6H32.8c-2.6 0-4.6-2.1-4.6-4.6-.1-2.5 2-4.6 4.6-4.6z"
      />
      <path
        d="M32.6 72.2h62.6c2 0 3.7 1.6 3.7 3.7v.1c0 2-1.6 3.7-3.7 3.7H32.6c-2 0-3.7-1.6-3.7-3.7v-.2c.1-2 1.7-3.6 3.7-3.6z"
        fill="#0a93e9"
      />
      <path
        fill="#FFF"
        d="M62 34.1l31.2 54c1.3 2.2.5 5-1.7 6.3-2.2 1.3-5 .5-6.3-1.7L54 38.7c-1.3-2.2-.5-5 1.7-6.3 2.2-1.3 5-.5 6.3 1.7z"
      />
      <linearGradient
        id="xcode-b"
        gradientUnits="userSpaceOnUse"
        x1="73.58"
        y1="94.25"
        x2="73.58"
        y2="32.642"
      >
        <stop offset="0" stopColor="#1285e7" />
        <stop offset="1" stopColor="#00b5ef" />
      </linearGradient>
      <path
        d="M61.2 34.5l31.3 54.2c1 1.7.4 4-1.3 5l-.2.1c-1.7 1-4 .4-5-1.3L54.7 38.2c-1-1.7-.4-4 1.3-5l.1-.1c1.8-1 4.1-.4 5.1 1.4z"
        fill="url(#xcode-b)"
      />
      <path
        fill="#FFF"
        d="M55.5 71.3c8.7-15 18.7-32.4 18.7-32.4 1.3-2.2.5-5-1.7-6.3-2.2-1.3-5-.5-6.3 1.7 0 0-12.2 21.2-21.4 37h10.7zm-5.4 9.2C45.9 87.7 43 92.9 43 92.9c-1.3 2.2-4.1 3-6.3 1.7s-3-4.1-1.7-6.3c0 0 1.7-3.1 4.4-7.7 3.4-.1 9.6-.1 10.7-.1z"
      />
      <linearGradient
        id="xcode-c"
        gradientUnits="userSpaceOnUse"
        x1="54.566"
        y1="94.401"
        x2="54.566"
        y2="32.794"
      >
        <stop offset="0" stopColor="#1285e7" />
        <stop offset="1" stopColor="#00b5ef" />
      </linearGradient>
      <path
        d="M54.4 71.3c8.8-15.2 19-32.9 19-32.9 1-1.7.4-4-1.3-5l-.1-.1c-1.7-1-4-.4-5 1.3 0 0-12 20.8-21.2 36.7h8.6zm-5.3 9.2c-4 7-6.9 12-6.9 12-1 1.7-3.2 2.3-5 1.3H37c-1.7-1-2.3-3.2-1.3-5 0 0 1.9-3.3 4.8-8.3h8.6z"
        fill="url(#xcode-c)"
      />
      <linearGradient
        id="xcode-d"
        gradientUnits="userSpaceOnUse"
        x1="84.758"
        y1="39.174"
        x2="94.522"
        y2="44.149"
      >
        <stop offset="0" stopColor="#344351" />
        <stop offset=".1" stopColor="#9697a0" />
        <stop offset=".47" stopColor="#71747d" />
        <stop offset=".8" stopColor="#8e8f94" />
        <stop offset=".9" stopColor="#606e84" />
      </linearGradient>
      <path
        d="M90.6 25.1s10.3 2.5 11.1 3.2-1.3 4.7-1.7 5.3c-3.3 4-13.6 26.1-13.6 26.1l-9.5-5.4s8.5-15.8 11.5-21.4c1.9-3.8 2.2-7.8 2.2-7.8z"
        fill="url(#xcode-d)"
      />
      <linearGradient
        id="xcode-e"
        gradientUnits="userSpaceOnUse"
        x1="58.131"
        y1="81.721"
        x2="73.237"
        y2="89.154"
      >
        <stop offset=".115" stopColor="#2c3952" />
        <stop offset=".55" stopColor="#474a54" />
        <stop offset="1" stopColor="#143052" />
      </linearGradient>
      <path
        d="M86.4 61c.4-.8.9-2-.2-2.9-1.2-.9-6.8-3.9-7.8-4.1-1-.2-1.8 0-2.2.7-.4.7-31.1 53.3-31.7 54.8-.6 1.5-.7 2.6.2 2.9.9.3 11.2 5.2 12.2 6.3 1 1.1 1.5-.1 1.9-.7 1.9-2.4 27.1-56.2 27.6-57z"
        fill="url(#xcode-e)"
      />
      <radialGradient
        id="xcode-f"
        cx="51.211"
        cy="114.953"
        r="7.901"
        fx="51.196"
        fy="117.292"
        gradientTransform="matrix(.8979 .4402 -.2506 .5111 34.032 33.662)"
        gradientUnits="userSpaceOnUse"
      >
        <stop offset=".417" stopColor="#0c0c12" />
        <stop offset="1" stopColor="#3d4651" />
      </radialGradient>
      <path
        d="M44.5 110.2c-.3.6-.8 1.3-.7 2.4.1 4.1 6.8 7.9 10.7 7.9 2.7 0 3.6-1.1 4.6-3.1s-13.5-9.6-14.6-7.2z"
        fill="url(#xcode-f)"
      />
      <linearGradient
        id="xcode-g"
        gradientUnits="userSpaceOnUse"
        x1="117.884"
        y1="29.257"
        x2="106.863"
        y2="14.364"
      >
        <stop offset=".27" stopColor="#262b33" />
        <stop offset=".45" stopColor="#74747e" />
        <stop offset=".54" stopColor="#b0b0bc" />
        <stop offset=".73" stopColor="#74747e" />
      </linearGradient>
      <path
        d="M114.4 19.9c1.8 1.3 4.2 1 6.1.7 1.3-.2-.7 1.7-2.9 6.1s-2.1 4.7-2.4 4.4c-.3-.3-10.2-5.9-9.9-6.4.4-.5 2-11.4 2.8-11.1 2.9.7 3.4 4.2 6.3 6.3z"
        fill="url(#xcode-g)"
      />
      <linearGradient
        id="xcode-h"
        gradientUnits="userSpaceOnUse"
        x1="98.542"
        y1="30.424"
        x2="114.815"
        y2="28.322"
      >
        <stop offset=".14" stopColor="#606e84" />
        <stop offset=".4" stopColor="#9899a5" />
        <stop offset=".73" stopColor="#475768" />
        <stop offset=".92" stopColor="#262b33" />
      </linearGradient>
      <path
        d="M99 32.2c.7-1.1 3.9-7.9 9-7.9 2.3 0 6.7 5.8 7.1 6.6.3.7-.7 3.5-1.2 2.2-.6-1.5-3.1-4.7-5.8-4.7s-6.4 3.1-7.3 4.2c-.9 1-2.5.7-1.8-.4z"
        fill="url(#xcode-h)"
      />
      <linearGradient
        id="xcode-i"
        gradientUnits="userSpaceOnUse"
        x1="116.332"
        y1="34.756"
        x2="123.707"
        y2="21.982"
      >
        <stop offset="0" stopColor="#858997" />
        <stop offset=".23" stopColor="#244668" />
        <stop offset=".4" stopColor="#040506" />
        <stop offset=".546" stopColor="#65656e" />
        <stop offset=".64" stopColor="#92929e" />
      </linearGradient>
      <path
        d="M120.7 20.6l5.5 2.8s-2.1 2.8-3.8 6c-1.8 3.4-3 7.1-3 7.1l-5.3-3.2s1.3-3.6 3.2-7.1c1.5-2.9 3.4-5.6 3.4-5.6z"
        fill="url(#xcode-i)"
      />
      <path
        d="M126.2 23.4c.4.2-.9 3.3-2.8 6.9-1.9 3.6-3.7 6.4-4 6.2-.4-.2.9-3.3 2.8-6.9 1.8-3.6 3.6-6.4 4-6.2z"
        fill="#bfc0d0"
      />
    </svg>
  )
}

const EDITOR_LABELS: Record<EditorOption, string> = {
  vscode: 'VS Code',
  cursor: 'Cursor',
  sublime: 'Sublime',
  webstorm: 'WebStorm',
  zed: 'Zed',
  custom: 'Editor'
}

const TERMINAL_LABELS: Record<TerminalOption, string> = {
  terminal: 'Terminal',
  iterm: 'iTerm',
  warp: 'Warp',
  alacritty: 'Alacritty',
  kitty: 'Kitty',
  ghostty: 'Ghostty',
  powershell: 'PowerShell',
  cmd: 'CMD',
  custom: 'Terminal'
}

function TerminalIcon({
  terminal,
  className
}: {
  terminal: TerminalOption
  className?: string
}): React.JSX.Element {
  switch (terminal) {
    case 'ghostty':
      return <GhosttyIcon className={className} />
    case 'warp':
      return <WarpIcon className={className} />
    default:
      return <Terminal className={className} />
  }
}

export function QuickActions(): React.JSX.Element | null {
  const { selectedWorktreeId, worktreesByProject } = useWorktreeStore()
  const selectedConnectionId = useConnectionStore((s) => s.selectedConnectionId)
  const selectedConnection = useConnectionStore((s) =>
    s.selectedConnectionId ? s.connections.find((c) => c.id === s.selectedConnectionId) : null
  )
  const defaultEditor = useSettingsStore((s) => s.defaultEditor)
  const defaultTerminal = useSettingsStore((s) => s.defaultTerminal)
  const customTerminalCommand = useSettingsStore((s) => s.customTerminalCommand)
  const [copied, setCopied] = useState(false)
  const [branchCopied, setBranchCopied] = useState(false)

  const isConnectionMode = !!selectedConnectionId && !selectedWorktreeId

  const selectedWorktree = (() => {
    if (!selectedWorktreeId) return null
    for (const worktrees of worktreesByProject.values()) {
      const wt = worktrees.find((w) => w.id === selectedWorktreeId)
      if (wt) return wt
    }
    return null
  })()

  // Use connection path when in connection mode, otherwise worktree path
  const activePath = isConnectionMode
    ? (selectedConnection?.path ?? null)
    : (selectedWorktree?.path ?? null)
  const branchName =
    !isConnectionMode && selectedWorktree?.branch_name && selectedWorktree.name !== '(no-worktree)'
      ? selectedWorktree.branch_name
      : null
  const disabled = !activePath

  const selectedProject = useProjectStore((s) =>
    s.selectedProjectId ? s.projects.find((p) => p.id === s.selectedProjectId) : null
  )
  const isSwiftProject = selectedProject?.language === 'swift'
  const isKotlinOrJava =
    selectedProject?.language === 'kotlin' || selectedProject?.language === 'java'
  const [xcworkspacePath, setXcworkspacePath] = useState<string | null>(null)
  const [isAndroidProject, setIsAndroidProject] = useState(false)

  useEffect(() => {
    if (!isSwiftProject || isConnectionMode) {
      setXcworkspacePath(null)
      return
    }
    const searchPath = activePath || selectedProject?.path
    if (!searchPath) {
      setXcworkspacePath(null)
      return
    }
    window.projectOps
      .findXcworkspace(searchPath)
      .then(setXcworkspacePath)
      .catch(() => setXcworkspacePath(null))
  }, [isSwiftProject, activePath, selectedProject?.path, isConnectionMode])

  useEffect(() => {
    if (!isKotlinOrJava || isConnectionMode) {
      setIsAndroidProject(false)
      return
    }
    const searchPath = activePath || selectedProject?.path
    if (!searchPath) {
      setIsAndroidProject(false)
      return
    }
    window.projectOps
      .isAndroidProject(searchPath)
      .then(setIsAndroidProject)
      .catch(() => setIsAndroidProject(false))
  }, [isKotlinOrJava, activePath, selectedProject?.path, isConnectionMode])

  const editorLabel = EDITOR_LABELS[defaultEditor]
  const terminalLabel = TERMINAL_LABELS[defaultTerminal]

  const handleOpenInEditor = useCallback(async () => {
    if (!activePath) return
    try {
      if (isConnectionMode) {
        await window.connectionOps.openInEditor(activePath)
      } else {
        await window.worktreeOps.openInEditor(activePath)
      }
    } catch (error) {
      console.error('Open in editor failed:', error)
    }
  }, [activePath, isConnectionMode])

  const handleAction = useCallback(
    async (actionId: string) => {
      if (!activePath) return
      try {
        if (actionId === 'editor') {
          await handleOpenInEditor()
        } else if (actionId === 'copy-path') {
          await window.projectOps.copyToClipboard(activePath)
          setCopied(true)
          setTimeout(() => setCopied(false), 1500)
        } else if (actionId === 'copy-branch') {
          if (!branchName) return
          await window.projectOps.copyToClipboard(branchName)
          setBranchCopied(true)
          setTimeout(() => setBranchCopied(false), 1500)
        } else if (actionId === 'finder') {
          await window.projectOps.showInFolder(activePath)
        } else if (actionId === 'terminal') {
          await window.settingsOps.openWithTerminal(
            activePath,
            defaultTerminal,
            defaultTerminal === 'custom' ? customTerminalCommand : undefined
          )
        } else {
          await window.systemOps.openInApp(actionId, activePath)
        }
      } catch (error) {
        console.error('Quick action failed:', error)
      }
    },
    [activePath, branchName, defaultTerminal, customTerminalCommand, handleOpenInEditor]
  )

  return (
    <div className="flex items-center gap-3" data-testid="quick-actions">
      {isSwiftProject && xcworkspacePath && !isConnectionMode && (
        <Button
          variant="ghost"
          size="sm"
          className="h-7 px-2 gap-1.5 text-xs cursor-pointer"
          disabled={disabled}
          onClick={() => window.projectOps.openPath(xcworkspacePath)}
          title="Open in Xcode"
          data-testid="quick-action-xcode"
        >
          <XcodeIcon className="h-3.5 w-3.5" />
          <span>Xcode</span>
        </Button>
      )}
      {isAndroidProject && !isConnectionMode && (
        <Button
          variant="ghost"
          size="sm"
          className="h-7 px-2 gap-1.5 text-xs cursor-pointer"
          disabled={disabled}
          onClick={() => {
            const openPath = activePath || selectedProject?.path
            if (openPath) window.systemOps.openInApp('android-studio', openPath)
          }}
          title="Open in Android Studio"
          data-testid="quick-action-android-studio"
        >
          <AndroidStudioIcon className="h-3.5 w-3.5" />
          <span>Android Studio</span>
        </Button>
      )}
      <Button
        variant="ghost"
        size="sm"
        className="h-7 px-2 gap-1.5 text-xs cursor-pointer"
        disabled={disabled}
        onClick={() => handleAction('editor')}
        title={`Open in ${editorLabel}`}
        data-testid="quick-action-editor"
      >
        {defaultEditor === 'cursor' ? (
          <CursorIcon className="h-3.5 w-3.5" />
        ) : (
          <Code className="h-3.5 w-3.5" />
        )}
        <span>{editorLabel}</span>
      </Button>
      <Button
        variant="ghost"
        size="sm"
        className="h-7 px-2 gap-1.5 text-xs cursor-pointer"
        disabled={disabled}
        onClick={() => handleAction('terminal')}
        title={`Open in ${terminalLabel}`}
        data-testid="quick-action-terminal"
      >
        <TerminalIcon terminal={defaultTerminal} className="h-3.5 w-3.5" />
        <span>{terminalLabel}</span>
      </Button>
      <Button
        variant="ghost"
        size="sm"
        className="h-7 px-2 gap-1.5 text-xs cursor-pointer"
        disabled={disabled}
        onClick={() => handleAction('copy-path')}
        title="Copy Path"
        data-testid="quick-action-copy-path"
      >
        {copied ? (
          <Check className="h-3.5 w-3.5 text-green-500" />
        ) : (
          <Copy className="h-3.5 w-3.5" />
        )}
        <span>{copied ? 'Copied' : 'Copy Path'}</span>
      </Button>
      <Button
        variant="ghost"
        size="sm"
        className="h-7 px-2 gap-1.5 text-xs cursor-pointer"
        disabled={disabled}
        onClick={() => handleAction('finder')}
        title={`Reveal in ${fileManagerName()}`}
        data-testid="quick-action-finder"
      >
        <FolderOpen className="h-3.5 w-3.5" />
        <span>{fileManagerName()}</span>
      </Button>
      {branchName && (
        <Button
          variant="ghost"
          size="sm"
          className="h-7 px-2 gap-1.5 text-xs cursor-pointer"
          onClick={() => handleAction('copy-branch')}
          title="Copy branch name"
          data-testid="quick-action-copy-branch"
        >
          {branchCopied ? (
            <Check className="h-3.5 w-3.5 text-green-500" />
          ) : (
            <GitBranch className="h-3.5 w-3.5" />
          )}
          <span>{branchCopied ? 'Copied' : 'Copy branch name'}</span>
        </Button>
      )}
    </div>
  )
}
