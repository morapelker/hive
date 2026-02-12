/**
 * Breed names for worktree naming convention
 * Uses well-known dog and cat breeds for memorable, unique names
 * All names are valid git branch names (lowercase, hyphens only)
 */

/**
 * Dog breeds — AKC-recognized breeds
 * All names are lowercase with hyphens, valid as git branch names
 */
export const DOG_BREEDS = [
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
  'chow-chow'
]

/**
 * Cat breeds — well-known pedigreed cat breeds
 * All names are lowercase with hyphens, valid as git branch names
 */
export const CAT_BREEDS = [
  'persian',
  'maine-coon',
  'ragdoll',
  'british-shorthair',
  'siamese',
  'abyssinian',
  'bengal',
  'birman',
  'oriental-shorthair',
  'sphynx',
  'devon-rex',
  'scottish-fold',
  'burmese',
  'russian-blue',
  'norwegian-forest',
  'cornish-rex',
  'somali',
  'tonkinese',
  'singapura',
  'ragamuffin',
  'turkish-angora',
  'american-shorthair',
  'balinese',
  'chartreux',
  'himalayan',
  'manx',
  'ocicat',
  'savannah',
  'siberian',
  'turkish-van',
  'bombay',
  'egyptian-mau',
  'havana-brown',
  'japanese-bobtail',
  'korat',
  'laperm',
  'nebelung',
  'pixie-bob',
  'selkirk-rex',
  'snowshoe',
  'american-curl',
  'burmilla',
  'exotic-shorthair',
  'munchkin',
  'peterbald',
  'toyger',
  'chausie',
  'lykoi',
  'khao-manee',
  'sokoke'
]

export const ALL_BREED_NAMES = [...DOG_BREEDS, ...CAT_BREEDS]

/** @deprecated Use DOG_BREEDS instead */
export const BREED_NAMES = DOG_BREEDS

export type BreedType = 'dogs' | 'cats'

function getBreedList(breedType: BreedType): string[] {
  return breedType === 'cats' ? CAT_BREEDS : DOG_BREEDS
}

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
export function getRandomBreedName(breedType: BreedType = 'dogs'): string {
  const list = getBreedList(breedType)
  const index = Math.floor(Math.random() * list.length)
  return list[index]
}

/**
 * Select a unique breed name that doesn't collide with existing names
 * If a random base name is taken, adds a numeric suffix (-2, -3, etc.)
 */
export function selectUniqueBreedName(
  existingNames: Set<string>,
  breedType: BreedType = 'dogs'
): string {
  const baseName = getRandomBreedName(breedType)
  if (!existingNames.has(baseName)) {
    return baseName
  }

  let version = 2
  let candidateName = `${baseName}-${version}`
  while (existingNames.has(candidateName)) {
    version++
    candidateName = `${baseName}-${version}`
  }
  return candidateName
}
