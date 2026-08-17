// PlayrunSync — Scriptable iOS
// Push the Next Up PocketCasts Episode to PlayRun. Clear all others from PlayRun.
const POCKETCASTS_TOKEN = Keychain.get("POCKETCASTS_TOKEN");
const PLAYRUN_TOKEN = Keychain.get("PLAYRUN_TOKEN");

async function requestJSON(url, method, token, body) {
    const req = new Request(url);
    req.method = method;
    req.headers = {
        Authorization: token,
        "Content-Type": "application/json",
    };
    if (body !== undefined) {
        req.body = JSON.stringify(body);
    }

    const data = await req.loadJSON();
    if (req.response.statusCode >= 400) {
        throw new Error(`HTTP ${req.response.statusCode} for ${url}: ${JSON.stringify(data)}`);
    }
    return data;
}

async function getPocketCastsPlaylist() {
    const data = await requestJSON(
        "https://api.pocketcasts.com/up_next/list",
        "POST",
        POCKETCASTS_TOKEN,
    );
    console.log("Success: Next Up Fetch");
    return data;
}

async function getPocketCastsEpisodeDetails(episodeUuid) {
    const data = await requestJSON(
        "https://api.pocketcasts.com/user/episode",
        "POST",
        POCKETCASTS_TOKEN,
        { uuid: episodeUuid },
    );
    console.log("Success: Get Episode Details");
    return data;
}

async function getPlayRunPodcastId(podcastName) {
    const data = await requestJSON(
        `https://www.playrun.app/api/podcast?search=${encodeURIComponent(podcastName)}&language=en&page=1`,
        "GET",
        PLAYRUN_TOKEN,
    );
    console.log("Success: Search PlayRun");
    // TODO Cache to local storage
    return data;
}

async function getPlayRunEpisodes(podcastUuid) {
    const data = await requestJSON(
        `https://www.playrun.app/api/podcast/${podcastUuid}`,
        "GET",
        PLAYRUN_TOKEN,
    );
    console.log("Success: Get Episode List");
    // TODO Cache to local storage
    return data;
}

async function insertPlayRunPlaylist(podcastUuid, episodeUuid) {
    const data = await requestJSON(
        "https://www.playrun.app/api/playlist/subscribe",
        "POST",
        PLAYRUN_TOKEN,
        { episode: { uuid: episodeUuid, podcast_uuid: podcastUuid } },
    );
    console.log("Success: Insert Episode");
    return data;
}

async function deletePlayRunPlaylist(podcastUuid, episodeUuid) {
    const data = await requestJSON(
        "https://www.playrun.app/api/playlist/subscribe",
        "DELETE",
        PLAYRUN_TOKEN,
        { uuid: episodeUuid, podcast_uuid: podcastUuid },
    );
    console.log("Success: Delete Episode");
    return data;
}

async function main() {
    // 1. Get PocketCasts Next Up
    const pocketCastsPlaylist = await getPocketCastsPlaylist();

    // 2. Parse and Get Episode(s)
    const pocketCastsEpisodeUuid = pocketCastsPlaylist.order[1];
    const pocketCastsEpisodeDetails = await getPocketCastsEpisodeDetails(
        pocketCastsEpisodeUuid,
    );
    const podcastTitle = pocketCastsEpisodeDetails.podcastTitle;
    const pocketCastsEpisodeUrl = pocketCastsEpisodeDetails.url;
    const pocketCastsEpisodeTitle = pocketCastsEpisodeDetails.title;

    // 3. Convert to PlayRun Episode
    const playRunSearchResults = await getPlayRunPodcastId(podcastTitle);
    const playRunPodcastUuid = playRunSearchResults.podcasts[0][0].uuid;
    const playRunEpisodeList = await getPlayRunEpisodes(playRunPodcastUuid);
    const matchingPlayRunEpisodes = playRunEpisodeList.episodes.filter(
        (episode) =>
            episode.url === pocketCastsEpisodeUrl ||
            episode.title === pocketCastsEpisodeTitle,
    );

    if (matchingPlayRunEpisodes.length === 0) {
        console.log("Failure: No matching episode found");
        console.log(
            JSON.stringify(pocketCastsEpisodeUrl),
            JSON.stringify(pocketCastsEpisodeTitle),
            JSON.stringify(playRunEpisodeList),
        );
        return { ok: false, reason: "No matching episode found on PlayRun" };
    }

    const playRunEpisodeUuid = matchingPlayRunEpisodes[0].uuid;

    // 4. Insert into PlayRun
    const playRunPlaylist = await insertPlayRunPlaylist(
        matchingPlayRunEpisodes[0].podcast.uuid,
        playRunEpisodeUuid,
    );
    let removedEpisodeCount = 0;

    for (const playlistEpisode of playRunPlaylist.playlist) {
        if (playlistEpisode.uuid !== playRunEpisodeUuid) {
            await deletePlayRunPlaylist(
                playlistEpisode.podcast.uuid,
                playlistEpisode.uuid,
            );
            removedEpisodeCount += 1;
        }
    }

    console.log(`${removedEpisodeCount} episodes removed.`);
    console.log(podcastTitle);
    console.log(pocketCastsEpisodeTitle);

    return {
        ok: true,
        removedEpisodeCount,
        podcastTitle,
        episodeTitle: pocketCastsEpisodeTitle,
    };
}

// Scriptable can't always rely on top-level await, so wrap execution explicitly.
(async () => {
    let result;
    try {
        result = await main();
    } catch (error) {
        console.error(String(error));
        Script.setShortcutOutput("PlayrunSync failed: " + error);
        if (config.runsInApp) {
            const a = new Alert();
            a.title = "PlayrunSync failed";
            a.message = String(error);
            a.addAction("OK");
            await a.presentAlert();
        }
        return;
    }

    const summary = result.ok
        ? `${result.removedEpisodeCount} episode(s) removed.\n\n${result.podcastTitle}\n${result.episodeTitle}`
        : result.reason || "Unknown failure";
    console.log(summary);
    Script.setShortcutOutput(summary);
    if (config.runsInApp) {
        const a = new Alert();
        a.title = result.ok ? "PlayrunSync complete" : "PlayrunSync: no match";
        a.message = summary;
        a.addAction("OK");
        await a.presentAlert();
    }
})();
