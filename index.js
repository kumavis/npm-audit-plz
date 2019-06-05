#!/usr/bin/env node

const npm = require('npm')
const audit = require('npm/lib/install/audit')
const pify = require('pify')
const fs = require('fs')
const lockVerify = require('lock-verify')
const deepClone = require('clone')
const readFile = pify(fs.readFile)
const pLimit = require('p-limit')
const pRetry = require('p-retry')

const limit = pLimit(20)

start().catch(console.error)

async function start () {
  const auditRequestData = await getNpmAuditData()
  const reports = await auditEachDep(auditRequestData)
  // console.log(JSON.stringify(reports, null, 2))
  const finalReport = unifyReports(reports)
  console.log(JSON.stringify(finalReport, null, 2))
}

function unifyReports (reports) {
  const finalReport = {
    prod: {},
    dev: {},
    errors: {},
  }
  Object.entries(reports).forEach(([packageName, report]) => {
    if (report.error) {
      finalReport.errors[packageName] = report.error
      return
    }
    if (!report.actions.length) return
    Object.values(report.advisories).forEach(entry => {
      entry.findings.forEach(finding => {
        const superContainer = finalReport[finding.dev ? 'dev' : 'prod']
        const container = superContainer[entry.severity] = superContainer[entry.severity] || {}
        const packageName = `${entry.module_name}@${finding.version}`
        const packageReport = container[packageName] = container[packageName] || { paths: [] }
        // make paths more readable
        const paths = finding.paths.map(path => path.split('>').join(' > '))
        packageReport.paths = packageReport.paths.concat(paths)
        packageReport.overview = entry.overview
      })
    })
  })
  return finalReport
}

async function auditEachDep (auditRequestData) {
  const deps = auditRequestData.requires 
  // console.log(auditRequestData)
  const topLevelDeps = Object.keys(deps)

  console.warn(`submitting audits for ${topLevelDeps.length} requests...`)

  const allResults = {}
  await Promise.all(topLevelDeps.map(async targetDep => {
    await limit(async () => {
      const singleReport = deepClone(auditRequestData)
      singleReport.requires = { [targetDep]: deps[targetDep] }
      try {
        await pRetry(async () => {
          try {
            const singleResult = await audit.submitForFullReport(singleReport)
            allResults[targetDep] = singleResult
            // log progress
            const progress = Object.keys(allResults).length
            const total = topLevelDeps.length
            const percent = (100*(progress/total)).toFixed(0)
            console.warn(`completed ${progress}/${total} (${percent}%)`)
          } catch (err) {
            console.warn(`${targetDep} audit failed...`)
            await new Promise(resolve => setTimeout(resolve, 1000))
            throw err
          }
        }, { retries: 2 })
      } catch (err) {
        allResults[targetDep] = { error: err.message }
      }
    })
  }))
  return allResults
}

async function getNpmAuditData () {
  await pify(cb => npm.load(cb))()

  const [shrinkwrap, lockfile, pkgJson] = await Promise.all([
    maybeReadFile('npm-shrinkwrap.json'),
    maybeReadFile('package-lock.json'),
    maybeReadFile('package.json')
  ])

  const sw = shrinkwrap || lockfile
  if (!pkgJson) {
    const err = new Error('No package.json found: Cannot audit a project without a package.json')
    err.code = 'EAUDITNOPJSON'
    throw err
  }
  if (!sw) {
    const err = new Error('Neither npm-shrinkwrap.json nor package-lock.json found: Cannot audit a project without a lockfile')
    err.code = 'EAUDITNOLOCK'
    throw err
  } else if (shrinkwrap && lockfile) {
    log.warn('audit', 'Both npm-shrinkwrap.json and package-lock.json exist, using npm-shrinkwrap.json.')
  }
  const requires = Object.assign(
    {},
    (pkgJson && pkgJson.dependencies) || {},
    (pkgJson && pkgJson.devDependencies) || {}
  )
  
  const result = await lockVerify(npm.prefix)
  if (!result.status) {
    const lockFile = shrinkwrap ? 'npm-shrinkwrap.json' : 'package-lock.json'
    const err = new Error(`Errors were found in your ${lockFile}, run  npm install  to fix them.\n    ` +
      result.errors.join('\n    '))
    err.code = 'ELOCKVERIFY'
    throw err
  }
  const auditRequestData = await audit.generate(sw, requires)
  return auditRequestData
}

async function maybeReadFile (name) {
  const file = `${npm.prefix}/${name}`
  try {
    const data = await readFile(file)
    try {
      // return parseJson(data)
      return JSON.parse(data)
    } catch (ex) {
      ex.code = 'EJSONPARSE'
      throw ex
    }
  } catch (err) {
    if (err.code === 'ENOENT') return
    err.file = file
    throw err
  }
}
