const express = require('express');
const axios = require('axios');
const cors = require('cors');
const sharp = require('sharp');
const https = require('https');
const NodeCache = require('node-cache');

const app = express();
const port = 3333;

app.use(cors());

// Inisialisasi cache dengan TTL default 1 menit
const cache = new NodeCache({ stdTTL: 60 });

// Variabel untuk melacak kegagalan sinkronisasi
let failCount = 0;
let externalDown = false;

const fivemAxios = axios.create({
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
    'Accept': 'application/json',
    'Accept-Language': 'en-US,en;q=0.9',
    'Origin': 'https://servers.fivem.net',
    'Referer': 'https://servers.fivem.net/'
  },
  timeout: 5000
});

const hexToDecimal = (s) => {
  let i, j, digits = [0], carry;
  for (i = 0; i < s.length; i += 1) {
    carry = parseInt(s.charAt(i), 16);
    for (j = 0; j < digits.length; j += 1) {
      digits[j] = digits[j] * 16 + carry;
      carry = (digits[j] / 10) | 0;
      digits[j] %= 10;
    }
    while (carry > 0) {
      digits.push(carry % 10);
      carry = (carry / 10) | 0;
    }
  }
  return digits.reverse().join('');
};

const getSteamProfileUrl = (ids) => {
  const filteredIdentifiers = ids.filter((identifier) => identifier.startsWith('steam:'));
  if (filteredIdentifiers.length > 0) {
    const steamId = hexToDecimal(filteredIdentifiers[0].split(':')[1]);
    return `https://steamcommunity.com/profiles/${steamId}`;
  }
  return null;
};

const getDiscordId = (ids) => {
  const filteredIdentifiers = ids.filter((identifier) => identifier.startsWith('discord:'));
  if (filteredIdentifiers.length > 0) {
    return filteredIdentifiers[0].split(':')[1];
  }
};

const getDiscordDetails = async (discordId) => {
  try {
    const response = await axios.get(`https://discordlookup.mesalytic.moe/v1/user/${discordId}`);
    if (response.data) {
      const { id, username, avatar } = response.data;
      return {
        id,
        username,
        avatarUrl: avatar ? `https://cdn.discordapp.com/avatars/${id}/${avatar.id}` : "https://via.placeholder.com/64",
      };
    }
  } catch (error) {
    console.error('Error fetching Discord user details:', error);
    return null;
  }
};

async function getImageSize(imageUrl) {
  try {
    const response = await axios({
      method: 'get',
      url: imageUrl,
      responseType: 'arraybuffer',
      httpsAgent: new https.Agent({ rejectUnauthorized: false })
    });
    const imageBuffer = Buffer.from(response.data, 'binary');
    const metadata = await sharp(imageBuffer).metadata();
    return {
      width: metadata.width,
      height: metadata.height
    };
  } catch (error) {
    console.error('Error fetching image size:', error);
    return null;
  }
}

async function fetchServerData() {
  let retries = 3;
  let response;
  
  while (retries > 0) {
    try {
      response = await fivemAxios.get('https://servers-frontend.fivem.net/api/servers/single/4ylb3o', {
        validateStatus: function (status) {
          return status < 500;
        }
      });
      
      if (response.status === 200) {
        return response.data.Data;
      }
      
      retries--;
      if (retries > 0) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    } catch (retryError) {
      console.error('Retry attempt failed:', retryError.message);
      retries--;
      if (retries > 0) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
  }

  throw new Error(`Failed to fetch data after retries. Status: ${response?.status}`);
}

async function syncServerData() {
  try {
    const serverData = await fetchServerData();
    // Jika berhasil, reset counter kegagalan dan flag eksternalDown
    failCount = 0;
    externalDown = false;

    let bannerSize = null;
    if (serverData?.vars?.banner_connecting) {
      bannerSize = await getImageSize(serverData.vars.banner_connecting);
    }

    const serverDetail = {
      totalplayer: serverData?.clients ?? 0,
      maxplayer: serverData?.sv_maxclients ?? 0,
      hostname: serverData?.hostname ?? 'Unknown',
      discord: serverData?.vars?.Discord ?? '',
      banner: {
        url: serverData?.vars?.banner_connecting ?? '',
        size: bannerSize ? `${bannerSize.width}x${bannerSize.height}` : 'Unknown'
      },
      logofivem: serverData?.ownerAvatar ?? '',
      players: serverData?.players ?? []
    };

    cache.set('serverDetail', serverDetail);
    console.log('Data server berhasil disinkronisasi.');
  } catch (error) {
    failCount++;
    console.error(`Sinkronisasi gagal ${failCount} kali:`, error.message);
    if (failCount >= 10) {
      externalDown = true;
      console.error('External server mati setelah 10 kali percobaan gagal.');
    }
  }
}

// Jalankan sinkronisasi pertama kali dan kemudian setiap 30 detik
syncServerData();
setInterval(syncServerData, 30000);

// Middleware untuk memeriksa status server eksternal sebelum merespon endpoint
function checkExternalStatus(req, res, next) {
  if (externalDown) {
    return res.status(503).json({ error: 'server eksternal mati' });
  }
  next();
}

// Endpoint untuk mendapatkan detail server dengan pemeriksaan status
app.get('/serverdetail', checkExternalStatus, (req, res) => {
  const serverDetail = cache.get('serverDetail');
  if (!serverDetail) {
    return res.status(503).json({ error: 'Data belum tersedia, coba lagi nanti.' });
  }

  const { players, ...result } = serverDetail;
  res.json(result);
});

app.get('/playerlist', checkExternalStatus, async (req, res) => {
  const serverDetail = cache.get('serverDetail');
  if (!serverDetail) {
    return res.status(503).json({ error: 'Data belum tersedia, coba lagi nanti.' });
  }

  try {
    const playerlist = await Promise.all((serverDetail.players || []).map(async (player) => {
      const steamProfileUrl = getSteamProfileUrl(player.identifiers ?? []);
      const discordId = getDiscordId(player.identifiers ?? []);
      
      let discordDetails = null;
      if (discordId) {
        discordDetails = await getDiscordDetails(discordId);
        if (discordDetails) {
          discordDetails = {
            discordId: discordDetails.id,
            usernameDiscord: discordDetails.username,
            discordPhoto: discordDetails.avatarUrl
          };
        }
      }
  
      return {
        id: player.id ?? '',
        name: player.name ?? 'Unknown',
        ping: player.ping ?? 0,
        steamProfileUrl: steamProfileUrl,
        discordDetails: discordDetails,
      };
    }));
  
    res.json({ playerlist });
  } catch (error) {
    console.error('Error processing player list:', error);
    res.status(500).json({ error: 'Terjadi kesalahan saat memproses data pemain.' });
  }
});

app.get('/', (req, res) => {
  res.status(200).json({ status: 'API OK' });
});

app.listen(port, () => {
  console.log(`Server is running on http://localhost:${port}`);
});
