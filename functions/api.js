import { DateTime } from 'luxon';

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
  const params = new URL(url).searchParams;
  const sortedKeys = [...params.keys()].sort();
  return sortedKeys.map(key => `${key}=${params.get(key)}`).join('&');
}

/**
 * Handles incoming HTTP requests to fetch timezone information.
 * @param {Object} context - The request context containing the HTTP request.
 * @returns {Promise<Response>} - The HTTP response.
 */
export async function onRequest(context) {
  const { request } = context;

  const corsHeaders = {
    "Access-Control-Allow-Origin": "*", // Adjust as needed for security
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  const cacheKey = generateCacheKey(request.url);

  const currentTime = Date.now();
  if (responseCache.has(cacheKey)) {
    const { response, timestamp } = responseCache.get(cacheKey);
    if (currentTime - timestamp <= 1000) { // Cache valid for 1 second
      return new Response(JSON.stringify(response, null, 2), {
        status: 200,
        headers: { 
          "Content-Type": "application/json",
          "Cache-Control": "public, max-age=1",
          ...corsHeaders,
        },
      });
    }
  }

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

  const url = new URL(request.url);
  const timezone = url.searchParams.get("timezone");

  if (!timezone) {
    return new Response(JSON.stringify({ error: "Missing 'timezone' query parameter." }), {
      status: 400,
      headers: { 
        "Content-Type": "application/json",
        ...corsHeaders,
      },
    });
  }

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
    const utcDate = new Date();

    const localISOString = getLocalISOString(utcDate, timezone);
    const offset = calculateUTCOffset(utcDate, timezone);
    const tzAbbreviation = getTimezoneAbbreviation(utcDate, timezone);
    const dayOfWeek = getDayOfWeek(utcDate, timezone);
    const isoWeekNumber = getISOWeekNumber(utcDate, timezone);

    const response = {
      local_time: localISOString,
      utc_time: utcDate.toISOString(),
      timezone: timezone,
      offset: offset,
      timezone_abbreviation: tzAbbreviation,
      day_of_week: dayOfWeek,
      iso_week_number: isoWeekNumber,
      timestamp_milliseconds: utcDate.getTime(),
    };

    responseCache.set(cacheKey, { response, timestamp: currentTime });

    return new Response(JSON.stringify(response, null, 2), {
      status: 200,
      headers: { 
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=1",
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
 * Converts the UTC date to the local ISO string in the specified timezone.
 * @param {Date} date - The current UTC date.
 * @param {string} timezone - The IANA timezone identifier.
 * @returns {string} - The local time in ISO 8601 format with timezone offset.
 */
function getLocalISOString(date, timezone) {
  return DateTime.fromJSDate(date, { zone: timezone }).toISO();
}

/**
 * Calculates the UTC offset for a given date and timezone.
 * @param {Date} date - The current UTC date.
 * @param {string} timezone - The IANA timezone identifier.
 * @returns {string} - The UTC offset in "+HH:MM" or "-HH:MM" format.
 */
function calculateUTCOffset(date, timezone) {
  const offset = DateTime.fromJSDate(date, { zone: timezone }).offset;
  const sign = offset >= 0 ? '+' : '-';
  const absOffset = Math.abs(offset);
  const hours = String(Math.floor(absOffset / 60)).padStart(2, '0');
  const minutes = String(absOffset % 60).padStart(2, '0');
  return `UTC${sign}${hours}:${minutes}`;
}

/**
 * Retrieves the timezone abbreviation.
 * @param {Date} date - The current UTC date.
 * @param {string} timezone - The IANA timezone identifier.
 * @returns {string} - The timezone abbreviation.
 */
function getTimezoneAbbreviation(date, timezone) {
  return DateTime.fromJSDate(date, { zone: timezone }).toFormat('ZZZ');
}

/**
 * Retrieves the day of the week for the local date in the specified timezone.
 * @param {Date} date - The current UTC date.
 * @param {string} timezone - The IANA timezone identifier.
 * @returns {string} - The day of the week.
 */
function getDayOfWeek(date, timezone) {
  return DateTime.fromJSDate(date, { zone: timezone }).toFormat('EEEE');
}

/**
 * Helper function to get ISO Week Number
 * @param {Date} date - The current UTC date.
 * @param {string} timezone - The IANA timezone identifier.
 * @returns {number} - The ISO week number.
 */
function getISOWeekNumber(date, timezone) {
  return DateTime.fromJSDate(date, { zone: timezone }).weekNumber;
}
