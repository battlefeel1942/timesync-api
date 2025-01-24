import { DateTime, Interval, Duration } from 'luxon';

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
    "Access-Control-Allow-Origin": "*",
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
    if (currentTime - timestamp <= 1000) {
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
    const utcNow = DateTime.utc();
    const localNow = utcNow.setZone(timezone);

    const response = {
      local_time: localNow.toISO(),
      utc_time: utcNow.toISO(),
      timezone: timezone,
      offset: localNow.offsetNameShort, // e.g., 'UTC+1'
      offset_minutes: localNow.offset,
      timezone_abbreviation: localNow.toFormat('ZZZ'), // e.g., 'PDT'
      day_of_week: localNow.toFormat('EEEE'), // Full day name
      ordinal_date: localNow.toFormat('o'), // Ordinal day of the year
      iso_week: localNow.weekNumber,
      iso_year: localNow.weekYear,
      days_in_month: localNow.daysInMonth,
      days_in_year: localNow.daysInYear,
      is_leap_year: localNow.isInLeapYear,
      start_of_day: localNow.startOf('day').toISO(),
      end_of_day: localNow.endOf('day').toISO(),
      duration_since_utc: Duration.fromObject({ milliseconds: localNow.diff(utcNow).toMillis() }).toHuman(),
      timestamp_milliseconds: localNow.toMillis(),
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
