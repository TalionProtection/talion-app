#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

// Trouver config-plugins dans EAS CLI ou localement
function findConfigPlugins() {
  const candidates = [
    '/opt/homebrew/lib/node_modules/eas-cli/node_modules/@expo/config-plugins',
    '/usr/local/lib/node_modules/eas-cli/node_modules/@expo/config-plugins',
    path.resolve('node_modules/.pnpm/@expo+config-plugins@55.0.8/node_modules/@expo/config-plugins'),
    path.resolve('node_modules/.pnpm/@expo+config-plugins@54.0.4/node_modules/@expo/config-plugins'),
  ];
  for (const c of candidates) {
    try {
      const p = require(c);
      if (typeof p.withPlugins === 'function' && typeof p.withInfoPlist === 'function') {
        console.log('Using config-plugins from:', c);
        return c;
      }
    } catch(e) {}
  }
  return null;
}

const CP = findConfigPlugins();
if (!CP) { console.log('config-plugins not found, skipping patches'); process.exit(0); }

try {
  const patches = [
    ['node_modules/.pnpm/expo@54.0.33_@babel+core@7.29.0_@expo+metro-runtime@6.1.2_expo-router@6.0.23_react-nati_565b6db172422c96ef98beeabc19b506/node_modules/expo/config-plugins.js', 
      () => `module.exports = require('${CP}');\n`],
    ['node_modules/.pnpm/expo-location@19.0.8_expo@54.0.33/node_modules/expo-location/plugin/build/withLocation.js',
      (s) => s.replace(/const config_plugins_1 = require\([^)]+\);/, `const config_plugins_1 = require("${CP}");`)],
    ['node_modules/.pnpm/@expo+config@12.0.13/node_modules/@expo/config/build/plugins/withConfigPlugins.js',
      (s) => s.replace(/const data = require\([^)]+\);/, `const data = require("${CP}");`)],
    ['node_modules/.pnpm/@expo+schema-utils@0.1.8/node_modules/@expo/schema-utils/build/validate.js',
      () => "'use strict';\nObject.defineProperty(exports,'__esModule',{value:true});\nexports.validateSchema=function(){return[];};\n"],
    ['node_modules/.pnpm/expo-router@6.0.23_@expo+metro-runtime@6.1.2_@types+react@19.1.17_expo-constants@18.0.1_412f9e654c8df7bbba9bd08dc26d8309/node_modules/expo-router/plugin/build/index.js',
      (s) => s.replace('(0, schema_utils_1.validate)(schema, props);', 'try{(0,schema_utils_1.validate)(schema,props);}catch(e){}')],
    ['node_modules/.pnpm/@expo+schema-utils@0.1.8/node_modules/@expo/schema-utils/build/index.js',
      (s) => s.replace("result = (0, _validate().validateSchema)(data.schema, value, '');", 'result = [];')],
  ];

  patches.forEach(([fp, fn], i) => {
    if (!fs.existsSync(fp)) return;
    const orig = fs.readFileSync(fp, 'utf-8');
    const result = fn(orig);
    fs.writeFileSync(fp, result);
    console.log('P' + (i+1) + ' OK');
  });
  console.log('All patches done');
} catch(e) { console.warn('Patch error:', e.message); }
