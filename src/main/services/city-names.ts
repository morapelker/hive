/**
 * City names for worktree naming convention
 * Uses major world cities for memorable, unique names
 */
export const CITY_NAMES = [
  // Asia
  'tokyo',
  'osaka',
  'kyoto',
  'seoul',
  'busan',
  'beijing',
  'shanghai',
  'shenzhen',
  'hongkong',
  'taipei',
  'singapore',
  'bangkok',
  'jakarta',
  'manila',
  'mumbai',
  'delhi',
  'bangalore',
  'dubai',
  'doha',
  'riyadh',

  // Europe
  'london',
  'paris',
  'berlin',
  'munich',
  'vienna',
  'zurich',
  'geneva',
  'amsterdam',
  'brussels',
  'barcelona',
  'madrid',
  'rome',
  'milan',
  'florence',
  'venice',
  'prague',
  'warsaw',
  'budapest',
  'stockholm',
  'oslo',
  'copenhagen',
  'helsinki',
  'dublin',
  'lisbon',
  'athens',
  'istanbul',
  'moscow',

  // North America
  'newyork',
  'losangeles',
  'chicago',
  'houston',
  'phoenix',
  'philadelphia',
  'sanantonio',
  'sandiego',
  'dallas',
  'austin',
  'denver',
  'seattle',
  'boston',
  'atlanta',
  'miami',
  'portland',
  'sanfrancisco',
  'toronto',
  'vancouver',
  'montreal',
  'calgary',
  'mexico',
  'guadalajara',

  // South America
  'saopaulo',
  'riodejaneiro',
  'buenosaires',
  'santiago',
  'lima',
  'bogota',
  'medellin',
  'caracas',
  'montevideo',

  // Africa
  'cairo',
  'lagos',
  'capetown',
  'johannesburg',
  'nairobi',
  'casablanca',
  'tunis',
  'addisababa',
  'dakar',
  'accra',

  // Oceania
  'sydney',
  'melbourne',
  'brisbane',
  'perth',
  'auckland',
  'wellington',

  // Additional memorable cities
  'telaviv',
  'jerusalem',
  'marrakech',
  'reykjavik',
  'monaco',
  'luxembourg',
  'helsinki',
  'tallinn',
  'riga',
  'vilnius',
  'bratislava',
  'ljubljana',
  'zagreb',
  'belgrade',
  'bucharest',
  'sofia',
  'kiev',
  'minsk',
  'tbilisi',
  'baku',
  'yerevan'
]

/**
 * Get a random city name from the list
 */
export function getRandomCityName(): string {
  const index = Math.floor(Math.random() * CITY_NAMES.length)
  return CITY_NAMES[index]
}

/**
 * Select a unique city name that doesn't collide with existing names
 * After MAX_ATTEMPTS, adds a numeric suffix (-v1, -v2, etc.)
 */
export function selectUniqueCityName(existingNames: Set<string>): string {
  const MAX_ATTEMPTS = 10

  // Try to find a unique city name
  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    const cityName = getRandomCityName()
    if (!existingNames.has(cityName)) {
      return cityName
    }
  }

  // After MAX_ATTEMPTS, use suffix strategy
  const baseName = getRandomCityName()
  let version = 1
  let candidateName = `${baseName}-v${version}`

  while (existingNames.has(candidateName)) {
    version++
    candidateName = `${baseName}-v${version}`
  }

  return candidateName
}
