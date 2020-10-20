'use strict';

delete Object.prototype.__proto__;

const Koa = require('koa');
const Router = require('@koa/router');
const fetch = require('node-fetch');
const joi = require('joi');
const Zip = require('jszip');
const Toml = require('@iarna/toml');

const modIdSchema = joi.number().positive().integer().label('modId');

const app = new Koa();
const router = new Router();

// TODO: grab changelog from curse by scraping page?
// TODO: accept ?mcRange=[1.16,)

router.get('/:modId', async ctx => {
  const modIdValidation = modIdSchema.validate(ctx.params.modId);
  if (modIdValidation.error) {
    ctx.body = { error: modIdValidation.error.message };
    ctx.status = 404;
    return;
  }

  const modId = modIdValidation.value;

  const mod = await getMod(modId);
  if (mod == null || mod.gameSlug !== 'minecraft' || mod.categorySection.path !== 'mods') {
    ctx.body = { error: `No mod with id ${modId} was found for game minecraft.` };
    ctx.status = 404;
    return;
  }

  // TODO: allow filtering by modId & authors[].userId so people can host their own version without
  //  risking other people using it in their mod and overloading their server

  const files = await getFiles(modId);

  const modCursePage = mod.websiteUrl;

  // const gameVersions = {};
  const latestRecommendedReleases = {};
  const latestReleases = {};

  for (const file of files) {
    // TODO: allow filtering between Fabric & Forge by adding ?fabric or ?forge query param.
    for (const mcVersion of file.gameVersion) {
      // skip versions like "Forge" or "Fabric"
      if (!/^[0-9.]+$/.test(mcVersion)) {
        continue;
      }

      const modVersion = extractModVersion(file.fileName);
      if (modVersion == null) {
        continue;
      }

      const fileDate = new Date(file.fileDate);
      if (!latestReleases[mcVersion] || latestReleases[mcVersion].date <= fileDate) {
        latestReleases[mcVersion] = { downloadUrl: file.downloadUrl, id: file.id, date: fileDate };
      }

      // int from 1 to 3
      // 1 = release
      // 2 = beta
      // 3 = alpha
      const releaseType = file.releaseType;
      if (
        !latestRecommendedReleases[mcVersion]
        || (latestRecommendedReleases[mcVersion].releaseType >= releaseType && latestRecommendedReleases[mcVersion].date <= fileDate)
      ) {
        latestRecommendedReleases[mcVersion] = { downloadUrl: file.downloadUrl, id: file.id, date: fileDate, releaseType };
      }
    }
  }

  const promos = {};
  const gameVersions = {};
  const promises = [];
  for (const gameVersion of Object.keys(latestReleases)) {
    promises.push(getVersionFromModFile(latestReleases[gameVersion].downloadUrl).then(version => {
      promos[`${gameVersion}-latest`] = version;
      gameVersions[gameVersion] = gameVersions[gameVersion] || {};
      gameVersions[gameVersion][version] = `View the changelog on CurseForge: ${modCursePage}/files/${latestReleases[gameVersion].id}`;
    }));
  }

  for (const gameVersion of Object.keys(latestRecommendedReleases)) {
    promises.push(getVersionFromModFile(latestRecommendedReleases[gameVersion].downloadUrl).then(version => {
      promos[`${gameVersion}-recommended`] = version;
      gameVersions[gameVersion] = gameVersions[gameVersion] || {};
      gameVersions[gameVersion][version] = `View the changelog on CurseForge: ${modCursePage}/files/${latestRecommendedReleases[gameVersion].id}`;
    }));
  }

  await Promise.all(promises);

  ctx.body = {
    homepage: modCursePage,
    ...gameVersions,
    promos,
  };
});

// TODO persist cache (pg? sqlite?)
const cache = new Map();

async function getVersionFromModFile(url) {
  if (!cache.has(url)) {
    cache.set(url, getVersionFromModFileUncached(url));
  }

  return cache.get(url);
}

async function getVersionFromModFileUncached(url) {
  const modJar = await downloadModFile(url);
  const data = await Zip.loadAsync(modJar);

  if (data.files['mcmod.info']) {
    const version = getVersionFromLegacyMcModInfo(await data.file("mcmod.info").async("string"));

    if (version != null) {
      return version;
    }
  }

  if (data.files['META-INF/mods.toml']) {
    const version = getVersionFromModsToml(await data.file("META-INF/mods.toml").async("string"));

    if (version != null) {
      return version;
    }
  }

  if (data.files['META-INF/MANIFEST.MF']) {
    const version = getVersionFromJarManifest(await data.file("META-INF/MANIFEST.MF").async("string"));

    if (version != null) {
      return version;
    }
  }

  return null;
}

function getVersionFromJarManifest(fileContents) {
  const manifest = parseJarManifest(fileContents);

  if (!manifest || !manifest.main) {
    return null;
  }

  return manifest.main['Implementation-Version'];
}

// https://github.com/limulus/jarfile/blob/master/src/Jar.js
function parseJarManifest(manifest) {
  var result = {"main": {}, "sections": {}}

  var expectingSectionStart = false
    , skip = 0
    , currentSection = null

  manifest = manifest.toString("utf8")
  var lines = manifest.split(/(?:\r\n|\r|\n)/);
  lines.forEach(function (line, i) {
    var entry;
    // this line may have already been processed, if so skip it
    if (skip) {
      skip--
      return
    }

    // Watch for blank lines, they mean we're starting a new section
    if (line === "") {
      expectingSectionStart = true
      return
    }

    // Extract the name and value from entry line
    var pair = line.match(/^([a-z0-9_-]+): (.*)$/i)
    if (!pair) {
      _throwManifestParseError("expected a valid entry", i, line)
    }
    var name = pair[1], val = (pair[2] || "")

    // Handle section start
    if (expectingSectionStart && name !== "Name") {
      _throwManifestParseError("expected section name", i, line)
    }
    else if (expectingSectionStart) {
      currentSection = val
      expectingSectionStart = false
      return
    }

    // Add entry to the appropriate section
    if (currentSection) {
      if (!result["sections"][currentSection]) {
        result["sections"][currentSection] = {}
      }
      entry = result["sections"][currentSection]
    }
    else {
      entry = result["main"]
    }
    entry[name] = val
    for (var j = i + 1; j < lines.length; j++) {
      var byteLen = Buffer.byteLength(line, "utf8")
      if (byteLen >= 70) {
        line = lines[j]
        if (line && line[0] === " ") {
          // continuation lines must start with a space
          entry[name] += line.substr(1)
          skip++
          continue
        }
      }
      break
    }
  })

  return result
}

function getVersionFromModsToml(fileContents) {
  const manifest = Toml.parse(fileContents);

  // TODO: what if there is more than one mod in the package? should compare with modId from somewhere

  if (!manifest || !Array.isArray(manifest.mods)) {
    return null;
  }

  const firstMod = manifest.mods[0];
  if (!firstMod) {
    return null;
  }

  const version = firstMod.version;

  // starting with ${ means there was some attempt at substituting a var but it failed
  // eg. version="${file.jarVersion}"
  // we'll fallback to the next possible source of version
  if (typeof version !== 'string' || version.startsWith('${')) {
    return null;
  }

  return version;
}

function getVersionFromLegacyMcModInfo(fileContents) {
  const mcModInfo = JSON.parse(fileContents);

  if (!Array.isArray(mcModInfo)) {
    return null;
  }

  // TODO: what if there is more than one mod in the package? should compare with modId from somewhere

  if (!mcModInfo[0]) {
    return null;
  }

  return mcModInfo[0].version;
}

async function downloadModFile(url) {
  const result = await fetch(url);

  return result.buffer();
}

function getFilePageId(modCursePage, fileId) {
  return `${modCursePage}/files/${fileId}`;
}

async function getMod(modId) {
  const response = await fetch(`https://addons-ecs.forgesvc.net/api/v2/addon/${encodeURIComponent(modId)}`);

  if (response.status === 404) {
    return null;
  }

  return response.json();
}

async function getFiles(modId) {
  const response = await fetch(`https://addons-ecs.forgesvc.net/api/v2/addon/${encodeURIComponent(modId)}/files`)

  return response.json();
}

/*
 * fileName must end with {modVersion}.jar, eg.
 * magicfeather-1.15.2-2.2.3.jar
 *
 * TODO: download mod, read contents of /META-INF/mods.toml & /mcmod.info ? (obviously needs to be cached)
 */
function extractModVersion(fileName) {
  const match = fileName.match(/(?<modVersion>[^-]+)\.jar$/);

  if (!match) {
    return null;
  }

  return match.groups.modVersion;
}

app.use(router.routes());
app.use(router.allowedMethods());
app.listen(process.env.PORT || 3000);
