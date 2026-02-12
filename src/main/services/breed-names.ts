/**
 * Dog breed names for worktree naming convention
 * Uses AKC-recognized breeds for memorable, unique names
 * All names are valid git branch names (lowercase, hyphens only)
 */
export const BREED_NAMES = [
  // Sporting Group
  'golden-retriever',
  'labrador',
  'cocker-spaniel',
  'pointer',
  'weimaraner',
  'vizsla',

  // Hound Group
  'beagle',
  'bloodhound',
  'greyhound',
  'dachshund',
  'basset-hound',

  // Working Group
  'boxer',
  'rottweiler',
  'doberman',
  'great-dane',
  'mastiff',
  'saint-bernard',
  'bernese',
  'newfoundland',
  'siberian-husky',
  'alaskan-malamute',
  'samoyed',
  'akita',
  'great-pyrenees',
  'tibetan-mastiff',
  'cane-corso',
  'dogue-de-bordeaux',
  'giant-schnauzer',
  'schnauzer',

  // Terrier Group
  'bull-terrier',
  'yorkshire-terrier',
  'jack-russell',
  'welsh-terrier',

  // Toy Group
  'chihuahua',
  'pomeranian',
  'maltese',
  'shih-tzu',
  'pekingese',
  'cavalier',
  'papillon',
  'pug',
  'toy-poodle',
  'miniature-pinscher',

  // Herding Group
  'border-collie',
  'german-shepherd',
  'australian-shepherd',
  'pembroke-corgi',
  'belgian-malinois',
  'cardigan-corgi',

  // Non-Sporting Group
  'bulldog',
  'poodle',
  'dalmatian',
  'boston-terrier',
  'french-bulldog',
  'shiba-inu',
  'chow-chow',
]

/**
 * Legacy city names — kept for backward-compatible auto-rename detection.
 * Worktrees created before the breed-name switch still have city-name branches.
 */
export const LEGACY_CITY_NAMES = [
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
 * Get a random breed name from the list
 */
export function getRandomBreedName(): string {
  const index = Math.floor(Math.random() * BREED_NAMES.length)
  return BREED_NAMES[index]
}

/**
 * Select a unique breed name that doesn't collide with existing names
 * After MAX_ATTEMPTS, adds a numeric suffix (-v1, -v2, etc.)
 */
export function selectUniqueBreedName(existingNames: Set<string>): string {
  const MAX_ATTEMPTS = 10

  // Try to find a unique breed name
  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    const breedName = getRandomBreedName()
    if (!existingNames.has(breedName)) {
      return breedName
    }
  }

  // After MAX_ATTEMPTS, use suffix strategy
  const baseName = getRandomBreedName()
  let version = 1
  let candidateName = `${baseName}-v${version}`

  while (existingNames.has(candidateName)) {
    version++
    candidateName = `${baseName}-v${version}`
  }

  return candidateName
}
