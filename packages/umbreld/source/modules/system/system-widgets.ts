import fs from 'node:fs/promises'
import prettyBytes from 'pretty-bytes'

import type Umbreld from '../../index.js'
import { getCpuUsage, getIpAddresses, getSystemDiskUsage, getSystemMemoryUsage } from './system.js'

type NetworkSample = {
	rxBytes: number
	txBytes: number
	ts: number
}

let lastNetworkSample: NetworkSample | null = null

const NETWORK_INTERFACE_EXCLUDES = [/^lo$/, /^br-/, /^docker/, /^services/, /^veth/]

function isAllowedInterface(name: string) {
	return !NETWORK_INTERFACE_EXCLUDES.some((pattern) => pattern.test(name))
}

function parseProcNetDev(content: string) {
	const lines = content.split('\n').slice(2)
	let rxBytes = 0
	let txBytes = 0

	for (const line of lines) {
		if (!line.trim()) continue
		const [rawName, rawData] = line.trim().split(':')
		if (!rawData) continue
		const iface = rawName.trim()
		if (!isAllowedInterface(iface)) continue
		const fields = rawData.trim().split(/\s+/)
		if (fields.length < 9) continue
		rxBytes += Number(fields[0]) || 0
		txBytes += Number(fields[8]) || 0
	}

	return {rxBytes, txBytes}
}

async function getNetworkRates() {
	try {
		const content = await fs.readFile('/proc/net/dev', 'utf8')
		const {rxBytes, txBytes} = parseProcNetDev(content)
		const now = Date.now()

		let rxPerSec = 0
		let txPerSec = 0
		if (lastNetworkSample) {
			const deltaSeconds = (now - lastNetworkSample.ts) / 1000
			if (deltaSeconds > 0) {
				rxPerSec = (rxBytes - lastNetworkSample.rxBytes) / deltaSeconds
				txPerSec = (txBytes - lastNetworkSample.txBytes) / deltaSeconds
				if (!Number.isFinite(rxPerSec) || rxPerSec < 0) rxPerSec = 0
				if (!Number.isFinite(txPerSec) || txPerSec < 0) txPerSec = 0
			}
		}

		lastNetworkSample = {rxBytes, txBytes, ts: now}
		return {rxPerSec, txPerSec}
	} catch {
		return {rxPerSec: 0, txPerSec: 0}
	}
}

function formatRate(rate: number) {
	if (!Number.isFinite(rate) || rate <= 0) return '0 B/s'
	return `${prettyBytes(rate)}/s`
}

export const systemWidgets = {
	storage: async function (umbreld: Umbreld) {
		const {size, totalUsed} = await getSystemDiskUsage(umbreld)

		return {
			type: 'text-with-progress',
			link: '?dialog=live-usage&tab=storage',
			refresh: '30s',
			title: 'Storage',
			text: prettyBytes(totalUsed),
			subtext: `/ ${prettyBytes(size)}`,
			progressLabel: `${prettyBytes(size - totalUsed)} left`,
			progress: (totalUsed / size).toFixed(2),
		}
	},
	memory: async function (umbreld: Umbreld) {
		const {size, totalUsed} = await getSystemMemoryUsage()

		return {
			type: 'text-with-progress',
			link: '?dialog=live-usage&tab=memory',
			refresh: '10s',
			title: 'Memory',
			text: prettyBytes(totalUsed),
			subtext: `/ ${prettyBytes(size)}`,
			progressLabel: `${prettyBytes(size - totalUsed)} left`,
			progress: (totalUsed / size).toFixed(2),
		}
	},
	'system-stats': async function (umbreld: Umbreld) {
		const [cpuUsage, diskUsage, memoryUsage] = await Promise.all([
			getCpuUsage(umbreld),
			getSystemDiskUsage(umbreld),
			getSystemMemoryUsage(),
		])

		const {totalUsed: cpuTotalUsed} = cpuUsage
		const {totalUsed: diskTotalUsed} = diskUsage
		const {totalUsed: memoryTotalUsed} = memoryUsage

		// Formats CPU usage to avoid scientific notation for usage >= 99.5% (e.g., 1.0e+2%)
		// and sets upper limit to 100% because we are calculating usage as a % of total system, not % of a single thread
		const formatCpuUsage = (usage: number) => {
			if (usage >= 99.5) return '100%'
			return `${usage.toPrecision(2)}%`
		}

		return {
			type: 'three-stats',
			link: '?dialog=live-usage',
			refresh: '10s',
			items: [
				{
					icon: 'system-widget-cpu',
					subtext: 'CPU',
					text: formatCpuUsage(cpuTotalUsed),
				},
				{
					icon: 'system-widget-memory',
					subtext: 'Memory',
					text: `${prettyBytes(memoryTotalUsed)}`,
				},
				{
					icon: 'system-widget-storage',
					subtext: 'Storage',
					text: `${prettyBytes(diskTotalUsed)}`,
				},
			],
		}
	},
	network: async function () {
		const {rxPerSec, txPerSec} = await getNetworkRates()
		const ip = getIpAddresses()[0] || '—'

		return {
			type: 'three-stats',
			link: '?dialog=live-usage',
			refresh: '5s',
			items: [
				{
					icon: 'download',
					subtext: 'Down',
					text: formatRate(rxPerSec),
				},
				{
					icon: 'upload',
					subtext: 'Up',
					text: formatRate(txPerSec),
				},
				{
					icon: 'network',
					subtext: 'IP',
					text: ip,
				},
			],
		}
	},
}
