import { callAllAbortControllers } from './utils/aborthandler/aborthandler'
import {
  Runner,
  WineInstallation,
  RpcClient,
  SteamRuntime,
  Release,
  GameInfo,
  GameSettings,
  State,
  ProgressInfo,
  GameStatus
} from 'common/types'
import axios from 'axios'
import { app, dialog, shell, Notification, BrowserWindow } from 'electron'
import {
  exec,
  ExecException,
  spawn,
  SpawnOptions,
  spawnSync
} from 'child_process'
import { existsSync, rmSync } from 'graceful-fs'
import { promisify } from 'util'
import i18next, { t } from 'i18next'

import {
  fixAsarPath,
  getSteamLibraries,
  configPath,
  gamesConfigPath,
  icon,
  isWindows,
  publicDir,
  GITHUB_API,
  isMac,
  configStore,
  isLinux,
  isSnap
} from './constants'
import {
  appendGameLog,
  logError,
  logInfo,
  LogPrefix,
  logsDisabled,
  logWarning
} from './logger/logger'
import { basename, dirname, join, normalize } from 'path'
import { runRunnerCommand as runLegendaryCommand } from 'backend/storeManagers/legendary/library'
import {
  gameInfoStore,
  installStore,
  libraryStore
} from 'backend/storeManagers/legendary/electronStores'
import {
  apiInfoCache as GOGapiInfoCache,
  installInfoStore as GOGinstallInfoStore,
  libraryStore as GOGlibraryStore
} from './storeManagers/gog/electronStores'
import {
  installStore as nileInstallStore,
  libraryStore as nileLibraryStore
} from './storeManagers/nile/electronStores'
import * as fileSize from 'filesize'
import makeClient from 'discord-rich-presence-typescript'
import { notify, showDialogBoxModalAuto } from './dialog/dialog'
import { getMainWindow, sendFrontendMessage } from './main_window'
import { GlobalConfig } from './config'
import { GameConfig } from './game_config'
import { validWine, runWineCommand } from './launcher'
import { gameManagerMap } from 'backend/storeManagers'
import {
  installWineVersion,
  updateWineVersionInfos,
  wineDownloaderInfoStore
} from './wine/manager/utils'
import { getHeroicVersion } from './utils/systeminfo/heroicVersion'
import { backendEvents } from './backend_events'
import { wikiGameInfoStore } from './wiki_game_info/electronStore'
import EasyDl from 'easydl'

import decompress from '@xhmikosr/decompress'
import decompressTargz from '@xhmikosr/decompress-targz'
import decompressTarxz from '@felipecrs/decompress-tarxz'

const execAsync = promisify(exec)

const { showMessageBox } = dialog

/**
 * Compares 2 SemVer strings following "major.minor.patch".
 * Checks if target is newer than base.
 */
function semverGt(target: string, base: string) {
  if (!target || !base) {
    return false
  }
  target = target.replace('v', '')

  // beta to beta
  if (base.includes('-beta') && target.includes('-beta')) {
    const bSplit = base.split('-beta.')
    const tSplit = target.split('-beta.')

    // same major beta?
    if (bSplit[0] === tSplit[0]) {
      base = bSplit[1]
      target = tSplit[1]
      return target > base
    } else {
      base = bSplit[0]
      target = tSplit[0]
    }
  }

  // beta to stable
  if (base.includes('-beta')) {
    base = base.split('-beta.')[0]
  }

  // stable to beta
  if (target.includes('-beta')) {
    target = target.split('-beta.')[0]
  }

  const [bmajor, bminor, bpatch] = base.split('.').map(Number)
  const [tmajor, tminor, tpatch] = target.split('.').map(Number)

  let isGE = false
  // A pretty nice piece of logic if you ask me. :P
  isGE ||= tmajor > bmajor
  isGE ||= tmajor === bmajor && tminor > bminor
  isGE ||= tmajor === bmajor && tminor === bminor && tpatch > bpatch
  return isGE
}

const getFileSize = fileSize.partial({ base: 2 }) as (arg: unknown) => string

function getWineFromProton(
  wineVersion: WineInstallation,
  winePrefix: string
): { winePrefix: string; wineBin: string } {
  if (wineVersion.type !== 'proton') {
    return { winePrefix, wineBin: wineVersion.bin }
  }

  winePrefix = join(winePrefix, 'pfx')

  // GE-Proton & Proton Experimental use 'files', Proton 7 and below use 'dist'
  for (const distPath of ['dist', 'files']) {
    const protonBaseDir = dirname(wineVersion.bin)
    const wineBin = join(protonBaseDir, distPath, 'bin', 'wine')
    if (existsSync(wineBin)) {
      return { wineBin, winePrefix }
    }
  }

  logError(
    [
      'Proton',
      wineVersion.name,
      'has an abnormal structure, unable to supply Wine binary!'
    ],
    LogPrefix.Backend
  )

  return { wineBin: '', winePrefix }
}

async function isEpicServiceOffline(
  type: 'Epic Games Store' | 'Fortnite' | 'Rocket League' = 'Epic Games Store'
) {
  const epicStatusApi = 'https://status.epicgames.com/api/v2/components.json'
  const notification = new Notification({
    title: `${type} ${t('epic.offline-notification-title', 'offline')}`,
    body: t(
      'epic.offline-notification-body',
      'Heroic will maybe not work probably!'
    ),
    urgency: 'normal',
    timeoutType: 'default',
    silent: false
  })

  try {
    const { data } = await axios.get(epicStatusApi)

    for (const component of data.components) {
      const { name: name, status: indicator } = component

      // found component and checking status
      if (name === type) {
        const isOffline = indicator === 'major'
        if (isOffline) {
          notification.show()
        }
        return isOffline
      }
    }

    notification.show()
    return false
  } catch (error) {
    logError(
      ['Failed to get epic service status with', error],
      LogPrefix.Backend
    )
    return false
  }
}

const showAboutWindow = () => {
  app.setAboutPanelOptions({
    applicationName: 'Heroic Games Launcher',
    applicationVersion: getHeroicVersion(),
    copyright: 'GPL V3',
    iconPath: icon,
    website: 'https://heroicgameslauncher.com'
  })
  return app.showAboutPanel()
}

async function handleExit() {
  const isLocked = existsSync(join(gamesConfigPath, 'lock'))
  const mainWindow = getMainWindow()

  if (isLocked && mainWindow) {
    const { response } = await showMessageBox(mainWindow, {
      buttons: [i18next.t('box.no'), i18next.t('box.yes')],
      message: i18next.t(
        'box.quit.message',
        'There are pending operations, are you sure?'
      ),
      title: i18next.t('box.quit.title', 'Exit')
    })

    if (response === 0) {
      return
    }

    // This is very hacky and can be removed if gogdl
    // and legendary handle SIGTERM and SIGKILL
    const possibleChildren = ['legendary', 'gogdl']
    possibleChildren.forEach((procName) => {
      try {
        killPattern(procName)
      } catch (error) {
        logInfo([`Unable to kill ${procName}, ignoring.`, error])
      }
    })

    // Kill all child processes
    callAllAbortControllers()
  }
  app.exit()
}

type ErrorHandlerMessage = {
  error?: string
  logPath?: string
  appName?: string
  runner: string
}

async function errorHandler({
  error,
  logPath,
  runner: r,
  appName
}: ErrorHandlerMessage): Promise<void> {
  const noSpaceMsg = 'Not enough available disk space'
  const plat = r === 'legendary' ? 'Legendary (Epic Games)' : r
  const deletedFolderMsg = 'appears to be deleted'
  const expiredCredentials = 'No saved credentials'
  const legendaryRegex = /legendary.*\.py/
  // this message appears on macOS when no Crossover was found in the system but its a false alarm
  const ignoreCrossoverMessage = 'IndexError: list index out of range'

  if (logPath) {
    execAsync(`tail "${logPath}" | grep 'disk space'`)
      .then(async ({ stdout }) => {
        if (stdout.includes(noSpaceMsg)) {
          logError(noSpaceMsg, LogPrefix.Backend)
          return showDialogBoxModalAuto({
            title: i18next.t('box.error.diskspace.title', 'No Space'),
            message: i18next.t(
              'box.error.diskspace.message',
              'Not enough available disk space'
            ),
            type: 'ERROR'
          })
        }
      })
      .catch((err: ExecException) => {
        // Grep returns 1 when it didn't find any text, which is fine in this case
        if (err.code !== 1) logInfo('operation interrupted', LogPrefix.Backend)
      })
  }
  if (error) {
    if (error.includes(ignoreCrossoverMessage)) {
      return
    }
    if (error.includes(deletedFolderMsg) && appName) {
      const runner = r.toLocaleLowerCase() as Runner
      const { title } = gameManagerMap[runner].getGameInfo(appName)
      const { response } = await showMessageBox({
        type: 'question',
        title,
        message: i18next.t(
          'box.error.folder-not-found.title',
          'Game folder appears to be deleted, do you want to remove the game from the installed list?'
        ),
        buttons: [i18next.t('box.no'), i18next.t('box.yes')]
      })

      if (response === 1) {
        return gameManagerMap[runner].forceUninstall(appName)
      }
    }

    if (legendaryRegex.test(error)) {
      const MemoryError = 'MemoryError: '
      if (error.includes(MemoryError)) {
        return
      }

      return showDialogBoxModalAuto({
        title: plat,
        message: i18next.t(
          'box.error.legendary.generic',
          'An error has occurred! Try to Logout and Login on your Epic account. {{newline}}  {{error}}',
          { error, newline: '\n' }
        ),
        type: 'ERROR'
      })
    }

    if (error.includes(expiredCredentials)) {
      return showDialogBoxModalAuto({
        title: plat,
        message: i18next.t(
          'box.error.credentials.message',
          'Your Crendentials have expired, Logout and Login Again!'
        ),
        type: 'ERROR'
      })
    }
  }
}

// If you ever modify this range of characters, please also add them to nile
// source as this function is used to determine how game directory will be named
function removeSpecialcharacters(text: string): string {
  const regexp = new RegExp(
    /[:|/|*|?|<|>|\\|&|{|}|%|$|@|`|!|™|+|'|"|®]/,
    'gi'
  )
  return text.replaceAll(regexp, '')
}

async function openUrlOrFile(url: string): Promise<string | void> {
  if (url.startsWith('http')) {
    return shell.openExternal(url)
  }
  return shell.openPath(url)
}

function clearCache(library?: 'gog' | 'legendary' | 'nile') {
  wikiGameInfoStore.clear()
  if (library === 'gog' || !library) {
    GOGapiInfoCache.clear()
    GOGlibraryStore.clear()
    GOGinstallInfoStore.clear()
  }
  if (library === 'legendary' || !library) {
    installStore.clear()
    libraryStore.clear()
    gameInfoStore.clear()
    runLegendaryCommand(
      { subcommand: 'cleanup' },
      { abortId: 'legandary-cleanup' }
    )
  }
  if (library === 'nile' || !library) {
    nileInstallStore.clear()
    nileLibraryStore.clear()
  }
}

function resetHeroic() {
  const appFolders = [gamesConfigPath, configPath]
  appFolders.forEach((folder) => {
    rmSync(folder, { recursive: true, force: true })
  })
  // wait a sec to avoid racing conditions
  setTimeout(() => {
    app.relaunch()
    app.quit()
  }, 1000)
}

function showItemInFolder(item: string) {
  if (existsSync(item)) {
    try {
      shell.showItemInFolder(item)
    } catch (error) {
      logError(
        ['Failed to show item in folder with:', error],
        LogPrefix.Backend
      )
    }
  }
}

function splitPathAndName(fullPath: string): { dir: string; bin: string } {
  const dir = dirname(fullPath)
  let bin = basename(fullPath)
  // On Windows, you can just launch executables that are in the current working directory
  // On Linux, you have to add a ./
  if (!isWindows) {
    bin = './' + bin
  }
  // Make sure to always return this as `dir, bin` to not break path
  // resolution when using `join(...Object.values(...))`
  return { dir, bin }
}

function getLegendaryBin(): { dir: string; bin: string } {
  const settings = GlobalConfig.get().getSettings()
  if (settings?.altLegendaryBin) {
    return splitPathAndName(settings.altLegendaryBin)
  }
  return splitPathAndName(
    fixAsarPath(join(publicDir, 'bin', process.platform, 'legendary'))
  )
}

function getGOGdlBin(): { dir: string; bin: string } {
  const settings = GlobalConfig.get().getSettings()
  if (settings?.altGogdlBin) {
    return splitPathAndName(settings.altGogdlBin)
  }
  return splitPathAndName(
    fixAsarPath(join(publicDir, 'bin', process.platform, 'gogdl'))
  )
}

function getNileBin(): { dir: string; bin: string } {
  const settings = GlobalConfig.get().getSettings()
  if (settings?.altNileBin) {
    return splitPathAndName(settings.altNileBin)
  }
  return splitPathAndName(
    fixAsarPath(join(publicDir, 'bin', process.platform, 'nile'))
  )
}

function getFormattedOsName(): string {
  switch (process.platform) {
    case 'linux':
      return 'Linux'
    case 'win32':
      return 'Windows'
    case 'darwin':
      return 'macOS'
    default:
      return 'Unknown OS'
  }
}

async function getSteamRuntime(
  requestedType: SteamRuntime['type']
): Promise<SteamRuntime> {
  const steamLibraries = await getSteamLibraries()
  const runtimeTypes: SteamRuntime[] = [
    {
      path: 'steamapps/common/SteamLinuxRuntime_sniper/run',
      type: 'sniper',
      args: ['--']
    },
    {
      path: 'steamapps/common/SteamLinuxRuntime_soldier/run',
      type: 'soldier',
      args: ['--']
    },
    {
      path: 'ubuntu12_32/steam-runtime/run.sh',
      type: 'scout',
      args: []
    }
  ]
  const allAvailableRuntimes: SteamRuntime[] = []
  steamLibraries.forEach((library) => {
    runtimeTypes.forEach(({ path, type, args }) => {
      const fullPath = join(library, path)
      if (existsSync(fullPath)) {
        allAvailableRuntimes.push({ path: fullPath, type, args })
      }
    })
  })
  // Add dummy runtime at the end to not return `undefined`
  allAvailableRuntimes.push({ path: '', type: 'scout', args: [] })
  const requestedRuntime = allAvailableRuntimes.find(({ type }) => {
    return type === requestedType
  })
  if (requestedRuntime) {
    return requestedRuntime
  }
  logWarning(
    [
      'No runtimes of type',
      requestedType,
      'could be found, returning first available one'
    ],
    LogPrefix.Backend
  )
  return allAvailableRuntimes.pop()!
}

function constructAndUpdateRPC(gameName: string): RpcClient {
  const client = makeClient('852942976564723722')
  client.updatePresence({
    details: gameName,
    instance: true,
    largeImageKey: 'icon_new',
    large_text: gameName,
    startTimestamp: Date.now(),
    state: 'via Heroic on ' + getFormattedOsName()
  })
  logInfo('Started Discord Rich Presence', LogPrefix.Backend)
  return client
}

const specialCharactersRegex =
  /('\w)|(\\(\w|\d){5})|(\\"(\\.|[^"])*")|[^((0-9)|(a-z)|(A-Z)|\s)]/g // addeed regex for capturings "'s" + unicodes + remove subtitles in quotes
const cleanTitle = (title: string) =>
  title
    .replaceAll(specialCharactersRegex, '')
    .replaceAll(' ', '-')
    .replaceAll('®', '')
    .toLowerCase()
    .split('--definitive')[0]

const formatEpicStoreUrl = (title: string) => {
  const storeUrl = `https://www.epicgames.com/store/product/`
  return `${storeUrl}${cleanTitle(title)}`
}

function quoteIfNecessary(stringToQuote: string) {
  const shouldQuote =
    typeof stringToQuote === 'string' &&
    !(stringToQuote.startsWith('"') && stringToQuote.endsWith('"')) &&
    stringToQuote.includes(' ')

  if (shouldQuote) {
    return `"${stringToQuote}"`
  }

  return String(stringToQuote)
}

function removeQuoteIfNecessary(stringToUnquote: string) {
  if (
    stringToUnquote &&
    stringToUnquote.startsWith('"') &&
    stringToUnquote.endsWith('"')
  ) {
    return stringToUnquote.replace(/^"+/, '').replace(/"+$/, '')
  }

  return String(stringToUnquote)
}

/**
 * Detects MS Visual C++ Redistributable and prompts for its installation if it's not found
 * Many games require this while not actually specifying it, so it's good to have
 *
 * Only works on Windows of course
 */
function detectVCRedist(mainWindow: BrowserWindow) {
  if (!isWindows) {
    return
  }

  const skip = configStore.get('skipVcRuntime', false)

  if (skip) {
    return
  }

  // According to this article avoid using wmic and Win32_Product
  // https://xkln.net/blog/please-stop-using-win32product-to-find-installed-software-alternatives-inside/
  // wmic is also deprecated
  const detectedVCRInstallations: string[] = []
  let stderr = ''

  // get applications
  const child = spawn('powershell.exe', [
    'Get-ItemProperty',
    'HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*,',
    'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
    '|',
    'Select-Object',
    'DisplayName',
    '|',
    'Format-Table',
    '-AutoSize'
  ])

  child.stdout.setEncoding('utf-8')
  child.stdout.on('data', (data: string) => {
    const splitData = data.split('\n')
    for (const installation of splitData) {
      if (installation && installation.includes('Microsoft Visual C++ 2022')) {
        detectedVCRInstallations.push(installation)
      }
    }
  })

  child.stderr.setEncoding('utf-8')
  child.stderr.on('data', (data: string) => {
    stderr += data
  })

  child.on('error', (error: Error) => {
    logError(['Check of VCRuntime crashed with:', error], LogPrefix.Backend)
    return
  })

  child.on('close', async (code: number) => {
    if (code) {
      logError(
        `Failed to check for VCRuntime installations\n${stderr}`,
        LogPrefix.Backend
      )
      return
    }
    // VCR installers install both the "Minimal" and "Additional" runtime, and we have 2 installers (x86 and x64) -> 4 installations in total
    if (detectedVCRInstallations.length < 4) {
      const { response } = await dialog.showMessageBox(mainWindow, {
        title: t('box.vcruntime.notfound.title', 'VCRuntime not installed'),
        message: t(
          'box.vcruntime.notfound.message',
          'The Microsoft Visual C++ Runtimes are not installed, which are required by some games'
        ),
        buttons: [
          t('box.downloadNow', 'Download now'),
          t('box.ok', 'Ok'),
          t('box.dontShowAgain', "Don't show again")
        ]
      })

      if (response === 2) {
        return configStore.set('skipVcRuntime', true)
      }

      if (response === 0) {
        openUrlOrFile('https://aka.ms/vs/17/release/vc_redist.x86.exe')
        openUrlOrFile('https://aka.ms/vs/17/release/vc_redist.x64.exe')
        dialog.showMessageBox(mainWindow, {
          message: t(
            'box.vcruntime.install.message',
            'The download links for the Visual C++ Runtimes have been opened. Please install both the x86 and x64 versions.'
          )
        })
      }
    } else {
      logInfo('VCRuntime is installed', LogPrefix.Backend)
    }
  })
}

function getFirstExistingParentPath(directoryPath: string): string {
  let parentDirectoryPath = directoryPath
  let parentDirectoryFound = existsSync(parentDirectoryPath)

  while (!parentDirectoryFound) {
    parentDirectoryPath = normalize(parentDirectoryPath + '/..')
    parentDirectoryFound = existsSync(parentDirectoryPath)
  }

  return parentDirectoryPath !== '.' ? parentDirectoryPath : ''
}

const getLatestReleases = async (): Promise<Release[]> => {
  const newReleases: Release[] = []
  logInfo('Checking for new Heroic Updates', LogPrefix.Backend)

  try {
    const { data: releases } = await axios.get(GITHUB_API)
    const latestStable: Release = releases.filter(
      (rel: Release) => rel.prerelease === false
    )[0]
    const latestBeta: Release = releases.filter(
      (rel: Release) => rel.prerelease === true
    )[0]

    const current = app.getVersion()

    const thereIsNewStable = semverGt(latestStable.tag_name, current)
    const thereIsNewBeta = semverGt(latestBeta.tag_name, current)

    if (thereIsNewStable) {
      newReleases.push({ ...latestStable, type: 'stable' })
    }
    if (thereIsNewBeta) {
      newReleases.push({ ...latestBeta, type: 'beta' })
    }

    if (newReleases.length) {
      notify({
        title: t('Update Available!'),
        body: t(
          'notify.new-heroic-version',
          'A new Heroic version was released!'
        )
      })
    }

    return newReleases
  } catch (error) {
    logError(
      ['Error when checking for Heroic updates', error],
      LogPrefix.Backend
    )
    return []
  }
}

const getCurrentChangelog = async (): Promise<Release | null> => {
  logInfo('Checking for current version changelog', LogPrefix.Backend)

  try {
    const current = app.getVersion()

    const { data: release } = await axios.get(`${GITHUB_API}/tags/v${current}`)

    return release as Release
  } catch (error) {
    logError(
      ['Error when checking for current Heroic changelog'],
      LogPrefix.Backend
    )
    return null
  }
}

function getInfo(appName: string, runner: Runner): GameInfo {
  return gameManagerMap[runner].getGameInfo(appName)
}

// can be removed if legendary and gogdl handle SIGTERM and SIGKILL
// for us
function killPattern(pattern: string) {
  logInfo(['Trying to kill', pattern], LogPrefix.Backend)
  let ret
  if (isWindows) {
    ret = spawnSync('Stop-Process', ['-name', pattern], {
      shell: 'powershell.exe'
    })
  } else {
    ret = spawnSync('pkill', ['-f', pattern])
  }
  logInfo(['Killed', pattern], LogPrefix.Backend)
  return ret
}

async function shutdownWine(gameSettings: GameSettings) {
  if (gameSettings.wineVersion.wineserver) {
    spawnSync(gameSettings.wineVersion.wineserver, ['-k'], {
      env: { WINEPREFIX: gameSettings.winePrefix }
    })
  } else {
    await runWineCommand({
      gameSettings,
      commandParts: ['wineboot', '-k'],
      wait: true,
      protonVerb: 'waitforexitandrun'
    })
  }
}

const getShellPath = async (path: string): Promise<string> =>
  normalize((await execAsync(`echo "${path}"`)).stdout.trim())

export const spawnAsync = async (
  command: string,
  args: string[],
  options: SpawnOptions = {},
  onOutput?: (data: string) => void
): Promise<{ code: number | null; stdout: string; stderr: string }> => {
  const child = spawn(command, args, options)
  const stdout = memoryLog()
  const stderr = memoryLog()

  if (child.stdout) {
    child.stdout.on('data', (data) => {
      if (onOutput) {
        onOutput(data.toString())
      }
      stdout.push(data.toString())
    })
  }

  if (child.stderr) {
    child.stderr.on('data', (data) => {
      if (onOutput) {
        onOutput(data.toString())
      }
      stderr.push(data.toString())
    })
  }

  return new Promise((resolve, reject) => {
    child.on('error', (error) =>
      reject({
        code: 1,
        stdout: stdout.join(''),
        stderr: stderr.join('').concat(error.message)
      })
    )
    child.on('close', (code) => {
      resolve({
        code,
        stdout: stdout.join(''),
        stderr: stderr.join('')
      })
    })
  })
}

async function ContinueWithFoundWine(
  selectedWine: string,
  foundWine: string
): Promise<{ response: number }> {
  const { response } = await dialog.showMessageBox({
    title: i18next.t('box.warning.wine-change.title', 'Wine not found!'),
    message: i18next.t('box.warning.wine-change.message', {
      defaultValue:
        'We could not find the selected wine version to launch this title ({{selectedWine}}). {{newline}} We found another one, do you want to continue launching using {{foundWine}} ?',
      newline: '\n',
      selectedWine: selectedWine,
      foundWine: foundWine
    }),
    buttons: [i18next.t('box.yes'), i18next.t('box.no')]
  })

  return { response }
}

export async function downloadDefaultWine() {
  // refresh wine list
  await updateWineVersionInfos(true)
  // get list of wines on wineDownloaderInfoStore
  const availableWine = wineDownloaderInfoStore.get('wine-releases', [])
  // use Wine-GE type if on Linux and Wine-Crossover if on Mac
  const release = availableWine.filter((version) => {
    if (isLinux) {
      return version.version.includes('Wine-GE-Proton')
    } else if (isMac) {
      return version.version.includes('Wine-Crossover')
    }
    return false
  })[0]

  if (!release) {
    logError('Could not find default wine version', LogPrefix.Backend)
    return null
  }

  // download the latest version
  const onProgress = (state: State, progress?: ProgressInfo) => {
    sendFrontendMessage('progressOfWineManager' + release.version, {
      state,
      progress
    })
  }
  const result = await installWineVersion(release, onProgress)

  if (result === 'success') {
    let downloadedWine = null
    try {
      const wineList = await GlobalConfig.get().getAlternativeWine()
      // update the game config to use that wine
      downloadedWine = wineList[0]
      logInfo(`Changing wine version to ${downloadedWine.name}`)
      GlobalConfig.get().setSetting('wineVersion', downloadedWine)
    } catch (error) {
      logError(
        ['Error when changing wine version to default', error],
        LogPrefix.Backend
      )
    }
    return downloadedWine
  }
  return null
}

export async function checkWineBeforeLaunch(
  appName: string,
  gameSettings: GameSettings
): Promise<boolean> {
  const wineIsValid = await validWine(gameSettings.wineVersion)

  if (wineIsValid) {
    return true
  } else {
    if (!logsDisabled) {
      logError(
        `Wine version ${gameSettings.wineVersion.name} is not valid, trying another one.`,
        LogPrefix.Backend
      )

      appendGameLog(
        appName,
        `Wine version ${gameSettings.wineVersion.name} is not valid, trying another one.`
      )
    }

    // check if the default wine is valid now
    const { wineVersion: defaultwine } = GlobalConfig.get().getSettings()
    const defaultWineIsValid = await validWine(defaultwine)
    if (defaultWineIsValid) {
      const { response } = await ContinueWithFoundWine(
        gameSettings.wineVersion.name,
        defaultwine.name
      )

      if (response === 0) {
        logInfo(`Changing wine version to ${defaultwine.name}`)
        gameSettings.wineVersion = defaultwine
        GameConfig.get(appName).setSetting('wineVersion', defaultwine)
        return true
      } else {
        logInfo('User canceled the launch', LogPrefix.Backend)
        return false
      }
    } else {
      const wineList = await GlobalConfig.get().getAlternativeWine()
      const firstFoundWine = wineList[0]

      const isValidWine = await validWine(firstFoundWine)

      if (!wineList.length || !firstFoundWine || !isValidWine) {
        const firstFoundWine = await downloadDefaultWine()
        if (firstFoundWine) {
          logInfo(`Changing wine version to ${firstFoundWine.name}`)
          gameSettings.wineVersion = firstFoundWine
          GameConfig.get(appName).setSetting('wineVersion', firstFoundWine)
          return true
        }
      }

      if (firstFoundWine && isValidWine) {
        const { response } = await ContinueWithFoundWine(
          gameSettings.wineVersion.name,
          firstFoundWine.name
        )

        if (response === 0) {
          logInfo(`Changing wine version to ${firstFoundWine.name}`)
          gameSettings.wineVersion = firstFoundWine
          GameConfig.get(appName).setSetting('wineVersion', firstFoundWine)
          return true
        } else {
          logInfo('User canceled the launch', LogPrefix.Backend)
          return false
        }
      }
    }
  }
  return false
}

export async function moveOnWindows(
  newInstallPath: string,
  gameInfo: GameInfo
): Promise<
  { status: 'done'; installPath: string } | { status: 'error'; error: string }
> {
  const {
    install: { install_path },
    title
  } = gameInfo

  if (!install_path) {
    return { status: 'error', error: 'No install path found' }
  }

  newInstallPath = join(newInstallPath, basename(install_path))

  let currentFile = ''
  let currentPercent = ''

  // move using robocopy and show progress of the current file being copied
  const { code, stderr } = await spawnAsync(
    'robocopy',
    [install_path, newInstallPath, '/MOVE', '/MIR'],
    { stdio: 'pipe' },
    (data) => {
      data = data.replaceAll(/\s/g, ' ')

      const match = data.split(' ').filter(Boolean)
      // current percentage
      const percent = match.filter((m) => m.includes('%'))[0]
      // current file
      const file = match[match.length - 1]
      if (percent) {
        currentPercent = percent
      }

      if (file && file.includes('.') && !file.includes('%')) {
        currentPercent = '0%'
        currentFile = file
      }

      if (match) {
        sendFrontendMessage(`progressUpdate-${gameInfo.app_name}`, {
          appName: gameInfo.app_name,
          runner: gameInfo.runner,
          status: 'moving',
          progress: {
            percent: currentPercent,
            file: currentFile
          }
        })
      }
    }
  )
  if (code !== 0) {
    logInfo(`Finished Moving ${title}`, LogPrefix.Backend)
  } else {
    logError(`Error: ${stderr}`, LogPrefix.Backend)
  }
  return { status: 'done', installPath: newInstallPath }
}

export async function moveOnUnix(
  newInstallPath: string,
  gameInfo: GameInfo
): Promise<
  { status: 'done'; installPath: string } | { status: 'error'; error: string }
> {
  const {
    install: { install_path },
    title
  } = gameInfo
  if (!install_path) {
    return { status: 'error', error: 'No install path found' }
  }

  const destination = join(newInstallPath, basename(install_path))

  let currentFile = ''
  let currentPercent = ''

  let rsyncExists = false
  try {
    await execAsync('which rsync')
    rsyncExists = true
  } catch (error) {
    logError(error, LogPrefix.Gog)
  }
  if (rsyncExists) {
    const origin = install_path + '/'
    logInfo(
      `moving command: rsync -az --progress ${origin} ${destination} `,
      LogPrefix.Backend
    )
    const { code, stderr } = await spawnAsync(
      'rsync',
      ['-az', '--progress', origin, destination],
      { stdio: 'pipe' },
      (data) => {
        const split =
          data
            .split('\n')
            .find((d) => d.includes('/') && !d.includes('%'))
            ?.split('/') || []
        const file = split.at(-1) || ''

        if (file) {
          currentFile = file
        }

        const percent = data.match(/(\d+)%/)
        if (percent) {
          currentPercent = percent[0]
          sendFrontendMessage(`progressUpdate-${gameInfo.app_name}`, {
            appName: gameInfo.app_name,
            runner: gameInfo.runner,
            status: 'moving',
            progress: {
              percent: currentPercent,
              file: currentFile
            }
          })
        }
      }
    )
    if (code !== 1) {
      logInfo(`Finished Moving ${title}`, LogPrefix.Backend)
      // remove the old install path
      await spawnAsync('rm', ['-rf', install_path])
    } else {
      logError(`Error: ${stderr}`, LogPrefix.Backend)
      return { status: 'error', error: stderr }
    }
  } else {
    const { code, stderr } = await spawnAsync('mv', [
      '-f',
      install_path,
      destination
    ])
    if (code !== 1) {
      return { status: 'done', installPath: destination }
    } else {
      logError(`Error: ${stderr}`, LogPrefix.Backend)
      return { status: 'error', error: stderr }
    }
  }
  return { status: 'done', installPath: destination }
}

// helper object for an array with a length limit
// this is used when calling system processes to not store the complete output in memory
//
// the `limit` is the number of messages, it doesn't mean it will be exactly `limit` lines since a message can be multi-line
const memoryLog = (limit = 50) => {
  const lines: string[] = []

  return {
    push: (newLine: string) => {
      lines.unshift(newLine)
      if (lines.length > limit) {
        lines.length = limit
      }
    },
    join: (separator = '') => {
      return lines.reverse().join(separator)
    }
  }
}

function removeFolder(path: string, folderName: string) {
  if (path === 'default') {
    const { defaultInstallPath } = GlobalConfig.get().getSettings()
    const path = defaultInstallPath.replaceAll("'", '')
    const folderToDelete = `${path}/${folderName}`
    if (existsSync(folderToDelete)) {
      return setTimeout(() => {
        rmSync(folderToDelete, { recursive: true })
      }, 5000)
    }
    return
  }

  const folderToDelete = `${path}/${folderName}`.replaceAll("'", '')
  if (existsSync(folderToDelete)) {
    return setTimeout(() => {
      rmSync(folderToDelete, { recursive: true })
    }, 2000)
  }
  return
}

function sendGameStatusUpdate(payload: GameStatus) {
  sendFrontendMessage('gameStatusUpdate', payload)
  backendEvents.emit('gameStatusUpdate', payload)
}

function sendProgressUpdate(payload: GameStatus) {
  sendFrontendMessage(`progressUpdate-${payload.appName}`, payload)
  backendEvents.emit(`progressUpdate-${payload.appName}`, payload)
}

interface ProgressCallback {
  (
    downloadedBytes: number,
    downloadSpeed: number,
    diskWriteSpeed: number,
    progress: number
  ): void
}

interface DownloadArgs {
  url: string
  dest: string
  abortSignal?: AbortSignal
  progressCallback?: ProgressCallback
}

/**
 * Downloads a file from a given URL to a specified destination path.
 * @param {string} url - The URL of the file to download.
 * @param {string} dest - The destination path to save the downloaded file.
 * @param {AbortSignal} abortSignal - The AbortSignal instance to cancel the download.
 * @param {ProgressCallback} [progressCallback] - An optional callback function to track the download progress.
 * @returns {Promise<void>} - A Promise that resolves when the download is complete.
 * @throws {Error} - If the download fails or is incomplete.
 */
export async function downloadFile({
  url,
  dest,
  abortSignal,
  progressCallback
}: DownloadArgs): Promise<void> {
  let lastProgressUpdateTime = Date.now()
  let lastBytesWritten = 0
  let fileSize = 0

  const connections = 5
  try {
    const response = await axios.head(url)
    fileSize = parseInt(response.headers['content-length'], 10)
  } catch (err) {
    logError(
      `Downloader: Failed to get headers for ${url}. \nError: ${err}`,
      LogPrefix.DownloadManager
    )
    throw new Error('Failed to get headers')
  }

  try {
    const dl = new EasyDl(url, dest, {
      existBehavior: 'overwrite',
      connections
    }).start()

    abortSignal?.addEventListener('abort', () => {
      dl.destroy()
    })

    dl.on('error', (error) => {
      logError(error, LogPrefix.Backend)
    })

    dl.on('retry', (retry) => {
      logInfo(`Retrying download: ${retry}`, LogPrefix.Backend)
    })

    const throttledProgressCallback = throttle(
      (
        bytes: number,
        speed: number,
        percentage: number,
        writingSpeed: number
      ) => {
        if (progressCallback) {
          logInfo(
            `Downloaded: ${bytesToSize(bytes)} / ${bytesToSize(
              fileSize
            )}  @${bytesToSize(speed)}/s (${percentage.toFixed(2)}%)`,
            LogPrefix.Backend
          )
          progressCallback(bytes, speed, percentage, writingSpeed)
        }
      },
      1000
    ) // Throttle progress reporting to 1 second

    dl.on('progress', ({ total }) => {
      const { bytes = 0, speed = 0, percentage = 0 } = total
      const currentTime = Date.now()
      const timeElapsed = currentTime - lastProgressUpdateTime

      if (timeElapsed >= 1000) {
        const bytesWrittenSinceLastUpdate = bytes - lastBytesWritten
        const writingSpeed = bytesWrittenSinceLastUpdate / (timeElapsed / 1000) // Bytes per second

        throttledProgressCallback(bytes, speed, percentage, writingSpeed)

        lastProgressUpdateTime = currentTime
        lastBytesWritten = bytes
      }
    })

    const downloaded = await dl.wait()

    if (!downloaded) {
      logWarning(
        `Downloader: Download stopped or paused`,
        LogPrefix.DownloadManager
      )
      throw new Error('Download stopped or paused')
    }

    logInfo(
      `Downloader: Finished downloading ${url}`,
      LogPrefix.DownloadManager
    )
  } catch (err) {
    logError(
      `Downloader: Download Failed with: ${err}`,
      LogPrefix.DownloadManager
    )
    throw new Error(`Download failed with ${err}`)
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function throttle<T extends (...args: any[]) => any>(
  callback: T,
  limit: number
): (...args: Parameters<T>) => void {
  let lastCall = 0
  return (...args: Parameters<T>) => {
    const now = Date.now()
    if (now - lastCall >= limit) {
      lastCall = now
      callback(...args)
    }
  }
}

function bytesToSize(bytes: number) {
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB']
  if (bytes === 0) return `0 ${sizes[0]}`
  const i = Math.floor(Math.log(bytes) / Math.log(1024))
  return `${parseFloat((bytes / Math.pow(1024, i)).toFixed(2))} ${sizes[i]}`
}

function formatTime(seconds: number): string {
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds - hours * 3600) / 60)
  const remainingSeconds = seconds - hours * 3600 - minutes * 60
  return `${hours.toString().padStart(2, '0')}:${minutes
    .toString()
    .padStart(2, '0')}:${remainingSeconds.toString().padStart(2, '0')}`
}

function calculateEta(
  downloadedBytes: number,
  downloadSpeed: number,
  downloadSize: number,
  lastProgressTime: number = Date.now()
): string | null {
  // Calculate the remaining seconds
  const remainingBytes = downloadSize - downloadedBytes
  const elapsedSeconds = (Date.now() - lastProgressTime) / 1000
  const remainingSeconds = remainingBytes / downloadSpeed - elapsedSeconds

  // Check if the download has completed or failed
  if (remainingSeconds <= 0) {
    return '00:00:00'
  } else if (!isFinite(remainingSeconds)) {
    return null
  }

  // Format the remaining seconds as "hh:mm:ss"
  const eta = formatTime(Math.floor(remainingSeconds))
  return eta
}

interface ExtractOptions {
  path: string
  destination: string
  strip: number
}

async function extractFiles({ path, destination, strip = 0 }: ExtractOptions) {
  if (!isSnap && (path.endsWith('.tar.xz') || path.endsWith('.tar.gz'))) {
    try {
      await extractNative(path, destination, strip)
    } catch (error) {
      logError(['Error:', error], LogPrefix.Backend)
    }
  } else {
    try {
      await extractDecompress(path, destination, strip)
    } catch (error) {
      logError(['Error:', error], LogPrefix.Backend)
    }
  }
}

async function extractNative(path: string, destination: string, strip: number) {
  logInfo(
    `Extracting ${path} to ${destination} using native tar`,
    LogPrefix.Backend
  )
  const { code, stderr } = await spawnAsync('tar', [
    '-xf',
    path,
    '-C',
    destination,
    `--strip-components=${strip}`
  ])
  if (code !== 0) {
    logError(`Extracting Error: ${stderr}`, LogPrefix.Backend)
    return { status: 'error', error: stderr }
  }
  return { status: 'done', installPath: destination }
}

async function extractDecompress(
  path: string,
  destination: string,
  strip: number
) {
  logInfo(
    `Extracting ${path} to ${destination} using decompress`,
    LogPrefix.Backend
  )
  try {
    await decompress(path, destination, {
      plugins: [decompressTargz(), decompressTarxz()],
      strip
    })
  } catch (error) {
    logError(['Error:', error], LogPrefix.Backend)
  }
}

export {
  errorHandler,
  execAsync,
  getCurrentChangelog,
  handleExit,
  isEpicServiceOffline,
  openUrlOrFile,
  showAboutWindow,
  showItemInFolder,
  removeSpecialcharacters,
  clearCache,
  resetHeroic,
  getLegendaryBin,
  getGOGdlBin,
  getNileBin,
  formatEpicStoreUrl,
  getSteamRuntime,
  constructAndUpdateRPC,
  quoteIfNecessary,
  removeQuoteIfNecessary,
  detectVCRedist,
  killPattern,
  shutdownWine,
  getInfo,
  getShellPath,
  getFirstExistingParentPath,
  getLatestReleases,
  getWineFromProton,
  getFileSize,
  memoryLog,
  removeFolder,
  sendGameStatusUpdate,
  sendProgressUpdate,
  calculateEta,
  extractFiles
}

// Exported only for testing purpose
// ts-prune-ignore-next
export const testingExportsUtils = {
  semverGt
}
