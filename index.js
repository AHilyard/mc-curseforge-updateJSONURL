'use strict';

delete Object.prototype.__proto__;

const Koa = require('koa');
const Router = require('@koa/router');
const fetch = require('node-fetch');
const joi = require('joi');

const modIdSchema = joi.number().positive().integer().label('modId');

const app = new Koa();
const router = new Router();

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

  const gameVersions = {};
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
        latestReleases[mcVersion] = { version: modVersion, date: fileDate };
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
        latestRecommendedReleases[mcVersion] = { version: modVersion, date: fileDate, releaseType };
      }

      gameVersions[mcVersion] = gameVersions[mcVersion] || {};
      // TODO: grab changelog from curse by scraping page?
      gameVersions[mcVersion][modVersion] = `Check out the changelog on CurseForge - ${modCursePage}/files/${file.id}`;
    }
  }

  const promos = {};
  for (const gameVersion of Object.keys(latestReleases)) {
    promos[`${gameVersion}-latest`] = latestReleases[gameVersion].version;
  }

  for (const gameVersion of Object.keys(latestRecommendedReleases)) {
    promos[`${gameVersion}-recommended`] = latestRecommendedReleases[gameVersion].version;
  }

  ctx.body = {
    homepage: modCursePage,
    ...gameVersions,
    promos,
  };
});

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
