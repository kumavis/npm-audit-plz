# npm-audit-plz

[![Greenkeeper badge](https://badges.greenkeeper.io/kumavis/npm-audit-plz.svg)](https://greenkeeper.io/)

Runs npm audits against each top-level package, with some retry. Helps get audit results if your audits are failing.

### usage

```js
npx npm-audit-plz > report.json
cat report.json | jq .
```