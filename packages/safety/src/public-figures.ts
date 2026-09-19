/**
 * Named public figures the prompt gate refuses (G12-202609191900).
 *
 * The operator's policy: real people appear in a film only through a consented cast
 * record (`kind: "consented-real-person"`, docs/CASTING.md). Nobody can attest consent
 * for a public figure from an anonymous studio, so naming one is refused outright,
 * whatever the cast says.
 *
 * This is a keyword list, not a likeness detector. It covers widely known living people
 * and recently deceased people whose likeness is commercially managed. Historical
 * figures are not listed. It is matched case-insensitively and accent-insensitively,
 * with spaces, hyphens and dots interchangeable, and only on whole words, so "Taylor
 * walks swiftly" passes. Growing it is always allowed; removing a name is a
 * safety-refusal shrink and needs a human gate (CLAUDE.md).
 *
 * Mononyms are listed only where the word has no everyday meaning ("Beyoncé" yes,
 * "Madonna", "Prince", "Drake" and "Adele" no).
 */
export const PUBLIC_FIGURES: readonly string[] = [
  // Heads of state and government, and senior politicians
  "Donald Trump", "Melania Trump", "Joe Biden", "Kamala Harris", "Barack Obama", "Michelle Obama", "Hillary Clinton",
  "Bill Clinton", "George W. Bush", "JD Vance", "Nancy Pelosi", "Alexandria Ocasio-Cortez", "Bernie Sanders",
  "Vladimir Putin", "Volodymyr Zelensky", "Volodymyr Zelenskyy", "Xi Jinping", "Kim Jong Un", "Narendra Modi",
  "Emmanuel Macron", "Keir Starmer", "Rishi Sunak", "Boris Johnson", "Justin Trudeau", "Mark Carney", "Olaf Scholz",
  "Friedrich Merz", "Angela Merkel", "Giorgia Meloni", "Benjamin Netanyahu", "Recep Tayyip Erdogan", "Javier Milei",
  "Lula da Silva", "Claudia Sheinbaum", "Mohammed bin Salman", "Ali Khamenei",
  // Royals and religious leaders
  "King Charles", "Queen Camilla", "Queen Elizabeth", "Prince Harry", "Prince William", "Meghan Markle", "Kate Middleton",
  "Princess Diana", "Pope Francis", "Pope Leo", "Dalai Lama",
  // Business and technology
  "Elon Musk", "Mark Zuckerberg", "Jeff Bezos", "Bill Gates", "Steve Jobs", "Tim Cook", "Sam Altman", "Jensen Huang",
  "Warren Buffett", "Sundar Pichai", "Satya Nadella",
  // Music
  "Taylor Swift", "Beyoncé", "Rihanna", "Lady Gaga", "Ariana Grande", "Billie Eilish", "Justin Bieber", "Selena Gomez",
  "Harry Styles", "Ed Sheeran", "Bad Bunny", "Dua Lipa", "Olivia Rodrigo", "Sabrina Carpenter", "Katy Perry",
  "Miley Cyrus", "Britney Spears", "Michael Jackson", "Elvis Presley", "Kanye West", "Jay-Z", "Kendrick Lamar",
  "Travis Scott", "Post Malone", "Nicki Minaj", "Cardi B", "Megan Thee Stallion", "Doja Cat", "Bruno Mars",
  "The Weeknd", "Elton John", "Paul McCartney", "Mick Jagger", "Bob Dylan", "Dolly Parton", "Snoop Dogg", "Eminem",
  "Shakira", "Lizzo", "Freddie Mercury", "John Lennon", "Whitney Houston", "Chappell Roan",
  // Film and television
  "Oprah Winfrey", "Oprah", "Tom Cruise", "Tom Hanks", "Brad Pitt", "Angelina Jolie", "Leonardo DiCaprio",
  "Scarlett Johansson", "Jennifer Lawrence", "Jennifer Aniston", "Jennifer Lopez", "Margot Robbie", "Ryan Reynolds",
  "Ryan Gosling", "Keanu Reeves", "Dwayne Johnson", "Will Smith", "Denzel Washington", "Morgan Freeman",
  "Samuel L. Jackson", "Robert Downey Jr.", "Johnny Depp", "Chris Hemsworth", "Chris Evans", "Chris Pratt",
  "Timothée Chalamet", "Zendaya", "Emma Watson", "Emma Stone", "Meryl Streep", "Nicole Kidman", "Natalie Portman",
  "Anne Hathaway", "Sydney Sweeney", "Pedro Pascal", "Cillian Murphy", "Jenna Ortega", "Florence Pugh", "Tom Holland",
  "Daniel Radcliffe", "Arnold Schwarzenegger", "Sylvester Stallone", "Jackie Chan", "Marilyn Monroe",
  "Audrey Hepburn", "Kim Kardashian", "Kylie Jenner", "Kendall Jenner", "Paris Hilton", "Joe Rogan", "MrBeast",
  "Gordon Ramsay", "Martha Stewart", "Jimmy Fallon", "Ellen DeGeneres",
  // Sport
  "LeBron James", "Michael Jordan", "Kobe Bryant", "Stephen Curry", "Serena Williams", "Venus Williams",
  "Cristiano Ronaldo", "Lionel Messi", "Neymar", "Kylian Mbappé", "Tom Brady", "Patrick Mahomes", "Travis Kelce",
  "Simone Biles", "Usain Bolt", "Tiger Woods", "Roger Federer", "Rafael Nadal", "Novak Djokovic", "Shohei Ohtani",
  "Caitlin Clark", "Muhammad Ali", "Conor McGregor", "Mike Tyson", "Lewis Hamilton", "Max Verstappen", "David Beckham",
  // Activists and others widely known by name
  "Greta Thunberg", "Malala Yousafzai",
];

/** Lower-case, strip accents, so "Beyoncé" and "BEYONCE" compare equal. */
export function foldForMatching(value: string): string {
  return value.normalize("NFKD").replace(/\p{M}+/gu, "").toLocaleLowerCase("en-US");
}

function namePattern(name: string): string {
  // Spaces, hyphens and dots are interchangeable separators; a trailing dot is optional.
  return foldForMatching(name).split(/[\s.-]+/).filter(Boolean)
    .map(part => part.replace(/[\\^$*+?()[\]{}|]/g, "\\$&")).join(String.raw`[\s.\-]*`);
}

/** One whole-word pattern over the folded text. */
export const PUBLIC_FIGURE_PATTERN = new RegExp(
  String.raw`(?<![\p{L}\p{N}])(?:` + PUBLIC_FIGURES.map(namePattern).join("|") + String.raw`)(?![\p{L}\p{N}])`, "u");

export function namesPublicFigure(text: string): boolean {
  return PUBLIC_FIGURE_PATTERN.test(foldForMatching(text));
}
