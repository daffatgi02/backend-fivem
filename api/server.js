const express = require('express');
const axios = require('axios');
const cors = require('cors');
const sharp = require('sharp'); // Import sharp
const https = require('https'); // Untuk menangani unduhan gambar via https

const app = express();
const port = 3333;

app.use(cors());

// Configure axios defaults
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

// Fungsi untuk mengonversi Steam ID dari hexadecimal ke decimal
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

// Fungsi untuk mendapatkan Steam Profile URL
const getSteamProfileUrl = (ids) => {
  const filteredIdentifiers = ids.filter((identifier) => identifier.startsWith('steam:'));
  if (filteredIdentifiers.length > 0) {
    const steamId = hexToDecimal(filteredIdentifiers[0].substring(filteredIdentifiers[0].indexOf(':') + 1));
    return `https://steamcommunity.com/profiles/${steamId}`; // URL Profil Steam
  }
  return null;
};

// Fungsi untuk mendapatkan Discord ID
const getDiscordId = (ids) => {
  const filteredIdentifiers = ids.filter((identifier) => identifier.startsWith('discord:'));
  if (filteredIdentifiers.length > 0) {
    return filteredIdentifiers[0].substring(filteredIdentifiers[0].indexOf(':') + 1);
  }
};

// Fungsi untuk mengambil data user Discord dari API
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

// Fungsi untuk mengambil ukuran gambar (banner)
async function getImageSize(imageUrl) {
  try {
    const response = await axios({
      method: 'get',
      url: imageUrl,
      responseType: 'arraybuffer', // Untuk mendapatkan data gambar dalam bentuk buffer
      httpsAgent: new https.Agent({ rejectUnauthorized: false }) // Jika perlu
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

// Fungsi untuk mengambil data server dari FiveM
async function fetchServerData() {
  let retries = 3;
  let response;
  
  while (retries > 0) {
    try {
      response = await fivemAxios.get('https://servers-frontend.fivem.net/api/servers/single/4ylb3o', {
        validateStatus: function (status) {
          return status < 500; // Resolve only if status is less than 500
        }
      });
      
      if (response.status === 200) {
        break;
      }
      
      retries--;
      if (retries > 0) {
        await new Promise(resolve => setTimeout(resolve, 1000)); // Wait 1 second before retry
      }
    } catch (retryError) {
      console.error('Retry attempt failed:', retryError.message);
      retries--;
      if (retries > 0) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
  }

  if (!response || response.status !== 200) {
    throw new Error(`Failed to fetch data after retries. Status: ${response?.status}`);
  }

  return response.data.Data;
}

// Endpoint untuk mendapatkan detail server
app.get('/serverdetail', async (req, res) => {
  try {
    const serverData = await fetchServerData();

    let bannerSize = null;
    if (serverData?.vars?.banner_connecting) {
      bannerSize = await getImageSize(serverData.vars.banner_connecting);
    }

    const result = {
      totalplayer: serverData?.clients ?? 0,
      maxplayer: serverData?.sv_maxclients ?? 0,
      hostname: serverData?.hostname ?? 'Unknown',
      discord: serverData?.vars?.Discord ?? '',
      banner: {
        url: serverData?.vars?.banner_connecting ?? '',
        size: bannerSize ? `${bannerSize.width}x${bannerSize.height}` : 'Unknown'
      },
      logofivem: serverData?.ownerAvatar ?? '',
    };

    res.json(result);
  } catch (error) {
    console.error('Error fetching server details:', error);
    res.status(503).json({ 
      error: 'Service temporarily unavailable',
      message: error.message,
      retryAfter: 60
    });
  }
});

// Endpoint untuk mendapatkan daftar pemain
app.get('/playerlist', async (req, res) => {
    try {
      const serverData = await fetchServerData();
  
      const playerlist = await Promise.all(serverData?.players?.map(async (player) => {
        const steamProfileUrl = getSteamProfileUrl(player.identifiers ?? []);
        const discordId = getDiscordId(player.identifiers ?? []);
        
        // Ambil detail Discord dari API eksternal
        let discordDetails = null;
        if (discordId) {
          discordDetails = await getDiscordDetails(discordId);
          discordDetails = {
            discordId: discordDetails.id,
            usernameDiscord: discordDetails.username,
            discordPhoto: discordDetails.avatarUrl
          };
        }
  
        return {
          id: player.id ?? '',
          name: player.name ?? 'Unknown',
          ping: player.ping ?? 0,
          steamProfileUrl: steamProfileUrl,  // URL Profil Steam
          discordDetails: discordDetails,    // Detail Discord
        };
      })) ?? [];
  
      res.json({ playerlist: playerlist });
    } catch (error) {
      console.error('Error fetching player list:', error);
      res.status(503).json({ 
        error: 'Service temporarily unavailable',
        message: error.message,
        retryAfter: 60
      });
    }
  });
  
  
// Health check endpoint
app.get('/', (req, res) => {
  res.status(200).json({ status: 'API OK' });
});

// Menjalankan server pada port yang sudah ditentukan
app.listen(port, () => {
  console.log(`Server is running on http://localhost:${port}`);
});
