// Cache the list of supported timezones to avoid redundant calls
const validTimezones = Intl.supportedValuesOf('timeZone');

// In-memory cache for storing responses with expiration timestamps
const responseCache = new Map();

// Rate limiting configuration
const RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1 minute
const RATE_LIMIT_MAX_REQUESTS = 100;
const rateLimitMap = new Map();

/**
 * Helper function to generate a unique cache key based on query parameters
 * @param {string} url - The full request URL
 * @returns {string} - A unique cache key
 */
function generateCacheKey(url) {
  // Extract search params from the URL
  const params = new URL(url).searchParams;

  // Sort the keys to ensure consistency (e.g., `timezone=Asia/Tokyo&format=json` === `format=json&timezone=Asia/Tokyo`)
  const sortedKeys = [...params.keys()].sort();

  // Build the cache key by joining sorted key-value pairs
  return sortedKeys.map(key => `${key}=${params.get(key)}`).join('&');
}

/**
 * Handles incoming HTTP requests to fetch timezone information.
 * @param {Object} context - The request context containing the HTTP request.
 * @returns {Promise<Response>} - The HTTP response.
 */
export async function onRequest(context) {
  const { request } = context;

  // Enable CORS by setting appropriate headers
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*", // Adjust as needed for security
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };

  // Handle preflight OPTIONS request for CORS
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: corsHeaders,
    });
  }

  // Generate a unique cache key based on the URL and query parameters
  const cacheKey = generateCacheKey(request.url);

  // Check if a response for this cacheKey exists and is still valid
  const currentTime = Date.now();
  if (responseCache.has(cacheKey)) {
    const { response, timestamp } = responseCache.get(cacheKey);
    if (currentTime - timestamp <= 1000) { // Cache valid for 1 second
      return new Response(JSON.stringify(response, null, 2), {
        status: 200,
        headers: { 
          "Content-Type": "application/json",
          "Cache-Control": "public, max-age=1", // Cache for 1 second
          ...corsHeaders,
        },
      });
    }
  }

  // Implement Rate Limiting
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const rateData = rateLimitMap.get(ip) || { count: 0, last: currentTime };

  if (currentTime - rateData.last < RATE_LIMIT_WINDOW_MS) {
    rateData.count += 1;
    if (rateData.count > RATE_LIMIT_MAX_REQUESTS) {
      return new Response(JSON.stringify({ error: "Rate limit exceeded. Please try again later." }), {
        status: 429,
        headers: { 
          "Content-Type": "application/json",
          ...corsHeaders,
        },
      });
    }
  } else {
    rateData.count = 1;
    rateData.last = currentTime;
  }
  rateLimitMap.set(ip, rateData);

  // Parse timezone from query parameters
  const url = new URL(request.url);
  const timezone = url.searchParams.get("timezone");

  // Validate presence of 'timezone' parameter
  if (!timezone) {
    return new Response(JSON.stringify({ error: "Missing 'timezone' query parameter." }), {
      status: 400,
      headers: { 
        "Content-Type": "application/json",
        ...corsHeaders,
      },
    });
  }

  // Validate timezone format using a regular expression (IANA timezone format)
  const timezonePattern = /^[A-Za-z_]+\/[A-Za-z_]+(?:\/[A-Za-z_]+)*$/;
  if (!timezonePattern.test(timezone)) {
    return new Response(JSON.stringify({ error: "Invalid timezone format. Please provide a valid IANA timezone identifier." }), {
      status: 400,
      headers: { 
        "Content-Type": "application/json",
        ...corsHeaders,
      },
    });
  }

  // Validate timezone against supported timezones
  if (!validTimezones.includes(timezone)) {
    return new Response(JSON.stringify({ error: `Invalid timezone '${timezone}'. Please provide a valid IANA timezone identifier.` }), {
      status: 400,
      headers: { 
        "Content-Type": "application/json",
        ...corsHeaders,
      },
    });
  }

  try {
    // Get current UTC time
    const utcDate = new Date();

    // Calculate local time ISO string
    const localISOString = getLocalISOString(utcDate, timezone);

    // Calculate UTC offset in "+HH:MM" or "-HH:MM" format
    const offset = calculateUTCOffset(utcDate, timezone);

    // Calculate UTC offset in milliseconds
    const offsetInMinutes = getTimezoneOffsetInMinutes(utcDate, timezone);
    const offsetMilliseconds = offsetInMinutes * 60000;

    // Get timezone abbreviation
    const tzAbbreviation = getTimezoneAbbreviation(utcDate, timezone);

    // Get Day of the Week
    const dayOfWeek = getDayOfWeek(utcDate, timezone);

    // Get ISO Week Number
    const isoWeekNumber = getISOWeekNumber(utcDate, timezone);

    // Prepare response
    const response = {
      local_time: localISOString,
      utc_time: utcDate.toISOString(),
      timezone: timezone,
      offset: offset,
      offset_milliseconds: offsetMilliseconds,
      timezone_abbreviation: tzAbbreviation,
      day_of_week: dayOfWeek,
      iso_week_number: isoWeekNumber,
      timestamp_milliseconds: utcDate.getTime(),
    };

    // Store the response in the cache with the cacheKey
    responseCache.set(cacheKey, { response, timestamp: currentTime });

    return new Response(JSON.stringify(response, null, 2), {
      status: 200,
      headers: { 
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=1", // Cache for 1 second
        ...corsHeaders,
      },
    });
  } catch (error) {
    console.error(`Error processing request for key '${cacheKey}':`, error);

    return new Response(JSON.stringify({ error: "Internal Server Error. Please try again later." }), {
      status: 500,
      headers: { 
        "Content-Type": "application/json",
        ...corsHeaders,
      },
    });
  }
}

/**
 * Calculates the UTC offset for a given date and timezone.
 * @param {Date} date - The current UTC date.
 * @param {string} timezone - The IANA timezone identifier.
 * @returns {string} - The UTC offset in "+HH:MM" or "-HH:MM" format.
 */
function calculateUTCOffset(date, timezone) {
  // Get the timezone offset in minutes
  const offsetInMinutes = getTimezoneOffsetInMinutes(date, timezone);

  const sign = offsetInMinutes >= 0 ? '+' : '-';
  const absOffset = Math.abs(offsetInMinutes);
  const hours = String(Math.floor(absOffset / 60)).padStart(2, '0');
  const minutes = String(absOffset % 60).padStart(2, '0');

  return `UTC${sign}${hours}:${minutes}`;
}

/**
 * Retrieves the timezone abbreviation.
 * @param {Date} date - The current UTC date.
 * @param {string} timezone - The IANA timezone identifier.
 * @returns {string} - The timezone abbreviation (e.g., NZDT, NZST).
 */
function getTimezoneAbbreviation(date, timezone) {
  const options = { timeZone: timezone, timeZoneName: 'short' };
  const parts = new Intl.DateTimeFormat('en-US', options).formatToParts(date);
  const timeZoneName = parts.find(part => part.type === 'timeZoneName');
  return timeZoneName ? timeZoneName.value : '';
}

/**
 * Retrieves the timezone offset in minutes for a given date and timezone.
 * @param {Date} date - The current UTC date.
 * @param {string} timezone - The IANA timezone identifier.
 * @returns {number} - The UTC offset in minutes.
 */
function getTimezoneOffsetInMinutes(date, timezone) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });

  const parts = formatter.formatToParts(date);
  const values = {};
  for (const part of parts) {
    values[part.type] = part.value;
  }

  // Construct a Date object in the target timezone
  const tzDate = new Date(`${values.year}-${values.month}-${values.day}T${values.hour}:${values.minute}:${values.second}Z`);
  
  // Calculate the offset in minutes and round to eliminate fractional minutes
  const offsetInMinutes = Math.round((tzDate - date) / 60000);

  return offsetInMinutes;
}

/**
 * Converts the UTC date to the local ISO string in the specified timezone.
 * @param {Date} date - The current UTC date.
 * @param {string} timezone - The IANA timezone identifier.
 * @returns {string} - The local time in ISO 8601 format with timezone offset.
 */
function getLocalISOString(date, timezone) {
  const offsetInMinutes = getTimezoneOffsetInMinutes(date, timezone);
  const sign = offsetInMinutes >= 0 ? '+' : '-';
  const absOffset = Math.abs(offsetInMinutes);
  const hours = String(Math.floor(absOffset / 60)).padStart(2, '0');
  const minutes = String(absOffset % 60).padStart(2, '0');
  
  // Calculate local time in milliseconds
  const localTimestamp = date.getTime() + offsetInMinutes * 60000;
  const localDate = new Date(localTimestamp);
  
  // Extract components in UTC to avoid timezone issues
  const year = localDate.getUTCFullYear();
  const month = String(localDate.getUTCMonth() + 1).padStart(2, '0');
  const day = String(localDate.getUTCDate()).padStart(2, '0');
  const hour = String(localDate.getUTCHours()).padStart(2, '0');
  const minuteStr = String(localDate.getUTCMinutes()).padStart(2, '0');
  const second = String(localDate.getUTCSeconds()).padStart(2, '0');

  return `${year}-${month}-${day}T${hour}:${minuteStr}:${second}${sign}${hours}:${minutes}`;
}

/**
 * Retrieves the day of the week for the local date in the specified timezone.
 * @param {Date} date - The current UTC date.
 * @param {string} timezone - The IANA timezone identifier.
 * @returns {string} - The day of the week (e.g., Friday).
 */
function getDayOfWeek(date, timezone) {
  const options = { timeZone: timezone, weekday: 'long' };
  return new Intl.DateTimeFormat('en-US', options).format(date);
}

/**
 * Helper function to get ISO Week Number
 * @param {Date} date - The current UTC date.
 * @param {string} timezone - The IANA timezone identifier.
 * @returns {number} - The ISO week number.
 */
function getISOWeekNumber(date, timezone) {
  // Convert UTC date to target timezone's local time
  const localISOString = getLocalISOString(date, timezone);
  const localDate = new Date(localISOString);

  // Set to nearest Thursday: current date + 4 - current day number
  // Make Sunday's day number 7
  const dayNumber = (localDate.getUTCDay() + 6) % 7; // Monday=0, Sunday=6
  localDate.setUTCDate(localDate.getUTCDate() + 4 - dayNumber);

  // Get first day of the year
  const week1 = new Date(Date.UTC(localDate.getUTCFullYear(), 0, 4));
  week1.setUTCDate(week1.getUTCDate() + 3 - ((week1.getUTCDay() + 6) % 7));

  // Calculate full weeks to the nearest Thursday
  const weekNumber = 1 + Math.round(((localDate - week1) / 86400000 - 3 + ((week1.getUTCDay() + 6) % 7)) / 7);

  return weekNumber;
}
