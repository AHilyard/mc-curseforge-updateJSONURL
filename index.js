'use strict';

delete Object.prototype.__proto__;

const Koa = require('koa');
const Router = require('@koa/router');
const fetch = require('node-fetch');
const joi = require('joi');

const modIdSchema = joi.number().positive().integer().label('modId');

const app = new Koa();
const router = new Router();
const minecraftId = 432;
const modsId = 6;

const authorId = "Grend_G";
//const baseApiUri = "https://api.curseforge.com";
const baseApiUri = "https://cfproxy.fly.dev";

router.get('/:modId', async ctx => {
	const modIdValidation = modIdSchema.validate(ctx.params.modId);
	if (modIdValidation.error)
	{
		ctx.body = { error: modIdValidation.error.message };
		ctx.status = 404;
		return;
	}

	const modId = modIdValidation.value;

	const mod = await getMod(modId);

	if (mod.authors[0].name !== authorId)
	{
		ctx.body = { error: "You are not authorized to use this service." };
		ctx.status = 401;
		return;
	}

	if (mod == null || mod.gameId !== minecraftId || mod.classId !== modsId)
	{
		ctx.body = { error: `No mod with id ${modId} was found for game minecraft.` };
		ctx.status = 404;
		return;
	}

	const files = await getFiles(modId);

	const modCursePage = mod.links.websiteUrl;

	const latestRecommendedReleases = {};
	const latestReleases = {};

	for (const file of files)
	{
		for (const mcVersion of file.gameVersions)
		{
			// Skip versions like "Forge" or "Fabric".
			if (!/^[0-9.]+$/.test(mcVersion))
			{
				continue;
			}

			const modVersion = extractModVersion(file.fileName);
			if (modVersion == null)
			{
				continue;
			}

			const fileDate = new Date(file.fileDate);
			if (!latestReleases[mcVersion] || latestReleases[mcVersion].date <= fileDate)
			{
				latestReleases[mcVersion] = { downloadUrl: file.downloadUrl, id: file.id, date: fileDate, version: modVersion };
			}

			// Release types:
			// 1 = release
			// 2 = beta
			// 3 = alpha
			const releaseType = file.releaseType;
			if (!latestRecommendedReleases[mcVersion] ||
				(latestRecommendedReleases[mcVersion].releaseType >= releaseType && latestRecommendedReleases[mcVersion].date <= fileDate))
			{
				latestRecommendedReleases[mcVersion] = { downloadUrl: file.downloadUrl, id: file.id, date: fileDate, releaseType, version: modVersion };
			}
		}
	}

	const promos = {};
	const gameVersions = {};

	for (const release of Object.keys(latestReleases))
	{
		const version = latestReleases[release].version;
		promos[`${release}-latest`] = version;
		gameVersions[release] = gameVersions[release] || {};
		gameVersions[release][version] = `View the changelog on CurseForge: ${modCursePage}/files/${latestReleases[release].id}`;
	}

	for (const release of Object.keys(latestRecommendedReleases))
	{
		const version = latestRecommendedReleases[release].version;
		promos[`${release}-recommended`] = version;
		gameVersions[release] = gameVersions[release] || {};
		gameVersions[release][version] = `View the changelog on CurseForge: ${modCursePage}/files/${latestRecommendedReleases[release].id}`;
	}

	ctx.body = {
		homepage: modCursePage,
		...gameVersions,
		promos,
	};
});

async function getMod(modId)
{
	const response = await fetch(`${baseApiUri}/v1/mods/${encodeURIComponent(modId)}`);

	if (response.status === 404)
	{
		return null;
	}

	return response.json().data;
}

async function getFiles(modId)
{
	const response = await fetch(`${baseApiUri}/v1/mods/${encodeURIComponent(modId)}/files`)

	return response.json().data;
}

/*
 * fileName must end with {modVersion}.jar, eg.
 * magicfeather-1.15.2-2.2.3.jar
*/
function extractModVersion(fileName)
{
	const match = fileName.match(/(?<modVersion>[^-]+)\.jar$/);

	if (!match)
	{
		return null;
	}

	return match.groups.modVersion;
}

app.use(router.routes());
app.use(router.allowedMethods());
app.listen(process.env.PORT || 3000);
