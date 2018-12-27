const assert = require('assert');
const MongoClient = require('mongodb').MongoClient;
const {inspect} = require('util'); //for debugging

'use strict';

//Used to prevent warning messages from mongodb.
const MONGO_OPTIONS = {
  useNewUrlParser: true,
  native_parser: true
};

/** Regex used for extracting words as maximal non-space sequences. */
const WORD_REGEX = /\S+/g;
const MY_WORD_REGEX = /\s+/g;

/** A simple utility class which packages together the result for a
 *  document search as documented above in DocFinder.find().
 */
class Result {
  constructor(name, score, lines) {
    this.name = name;
    this.score = score;
    this.lines = lines;
  }

  toString() {
    return `${this.name}: ${this.score}\n${this.lines}`;
  }
}

/** Compare result1 with result2: higher scores compare lower; if
 *  scores are equal, then lexicographically earlier names compare
 *  lower.
 */
function compareResults(result1, result2) {
  return (result2.score - result1.score) ||
    result1.name.localeCompare(result2.name);
}

/** Normalize word by stem'ing it, removing all non-alphabetic
 *  characters and converting to lowercase.
 */
function normalize(word) {
  return stem(word.toLowerCase()).replace(/[^a-z]/g, '');
}

/** Place-holder for stemming a word before normalization; this
 *  implementation merely removes 's suffixes.
 */
function stem(word) {
  return word.replace(/\'s$/, '');
}


/** This class is expected to persist its state.  Hence when the
 *  class is created with a specific database url, it is expected
 *  to retain the state it had when it was last used with that URL.
 */
class DocFinder {

  /** Constructor for instance of DocFinder. The dbUrl is
   *  expected to be of the form mongodb://SERVER:PORT/DB
   *  where SERVER/PORT specifies the server and port on
   *  which the mongo database server is running and DB is
   *  name of the database within that database server which
   *  hosts the persistent content provided by this class.
   */
  constructor(dbUrl) {
    //TODO
    this.myDb = {};
    this.dbUrl = dbUrl;
    this.mongoClient = {};
  }

  /** This routine is used for all asynchronous initialization
   *  for instance of DocFinder.  It must be called by a client
   *  immediately after creating a new instance of this.
   */
  async init() {
    try{
      this.mongoClient = await MongoClient.connect(this.dbUrl, MONGO_OPTIONS);
      this.myDb = this.mongoClient.db('mydb');
    }catch (e) {
      throw(e);
    }

  }

  /** Release all resources held by this doc-finder.  Specifically,
   *  close any database connections.
   */
  async close() {
    await this.mongoClient.close();
  }

  /** Clear database */
  async clear() {
    await this.myDb.dropDatabase();
  }

  /** Return an array of non-noise normalized words from string
   *  contentText.  Non-noise means it is not a word in the noiseWords
   *  which have been added to this object.  Normalized means that
   *  words are lower-cased, have been stemmed and all non-alphabetic
   *  characters matching regex [^a-z] have been removed.
   */
  async words(sUserInput) {
    let aNoiseWordData = await this.getDataFromDbByColNameAndFindQuery('noiseWords', {name: 'noise-words'});
    let sNoiseWords = aNoiseWordData[0].data;
    let aUserInputWords = sUserInput.toLowerCase().split(MY_WORD_REGEX);

    let aDesiredWords = [];
    aUserInputWords.forEach(function (sWord) {
      let oRegex = new RegExp(`\\s+(${sWord})+\\s+`, "g");
      let aResult = sNoiseWords.match(oRegex);
      if (!aResult) {
        aDesiredWords.push(normalize(stem(sWord)));
      }
    });

    return aDesiredWords;
  }

  /** Add all normalized words in the noiseText string to this as
   *  noise words.  This operation should be idempotent.
   */
  async addNoiseWords(sNoiseWords) {
    let sTempNoiseWords = sNoiseWords.replace(/\n/g, " ").toLowerCase();

    let noiseCollection = this.myDb.collection('noiseWords');
    let aData = await this.getDataFromDbByColNameAndFindQuery('noiseWords', {name: "noise-words"});
    if (!aData.length) {
      await noiseCollection.insertOne({'name': "noise-words", 'data': sTempNoiseWords});
    } else {
      await noiseCollection.updateOne({name: 'noise-words'}, {$set: {'name': "noise-words", 'data': sTempNoiseWords}});
    }
  }

  /** Add document named by string name with specified content string
   *  contentText to this instance. Update index in this with all
   *  non-noise normalized words in contentText string.
   *  This operation should be idempotent.
   */
  async addContent(sName, sContent) {
    let aOriginalData = sContent.split(/\n+/g);
    let aProcessedData = [];

    aOriginalData.forEach(function (sOriginalDataLine) {
      let aTemp = [];
      sOriginalDataLine.split(" ").forEach(function (sWord) {
        aTemp.push(normalize(sWord));
      });
      aProcessedData.push(aTemp.join(" "));
    });

    let oTempData = {
      originalDocument: sContent,
      originalData: aOriginalData,
      processedData: aProcessedData
    };

    let myCollection = this.myDb.collection('textDocuments');
    let aData = await this.getDataFromDbByColNameAndFindQuery('textDocuments', {name: sName});
    if (!aData.length) {
      await myCollection.insertOne({'name': sName, 'data': oTempData});
    } else {
      await myCollection.updateOne({name: sName}, {$set: {'name': sName, 'data': oTempData}});
    }

  }

  /** Return contents of document name.  If not found, throw an Error
   *  object with property code set to 'NOT_FOUND' and property
   *  message set to `doc ${name} not found`.
   */
  async docContent(name) {
    //remove extension from file name if any.
    let iIndex = name.indexOf('.');
    let sName = iIndex > 0 ? name.slice(0, name.indexOf('.')) : name;

    try {
      let aData = await this.getDataFromDbByColNameAndFindQuery('textDocuments', {name: sName});
      return aData[0].data.originalDocument;
    } catch (e) {
      e.code = 'NOT_FOUND';
      e.message = `doc ${name} not found`;
      throw (e);
    }
  }

  /** Given a list of normalized, non-noise words search terms,
   *  return a list of Result's  which specify the matching documents.
   *  Each Result object contains the following properties:
   *
   *     name:  the name of the document.
   *     score: the total number of occurrences of the search terms in the
   *            document.
   *     lines: A string consisting the lines containing the earliest
   *            occurrence of the search terms within the document.  The
   *            lines must have the same relative order as in the source
   *            document.  Note that if a line contains multiple search
   *            terms, then it will occur only once in lines.
   *
   *  The returned Result list must be sorted in non-ascending order
   *  by score.  Results which have the same score are sorted by the
   *  document name in lexicographical ascending order.
   *
   */
  async find(aUserInputWords) {
    //all terms regex.
    let sAllTermsRegex = "";
    aUserInputWords.forEach(function (sUserInputWord, iIndex) {
      sAllTermsRegex += (iIndex === 0 ? "" : "|") + "(\\b" + sUserInputWord + "\\b)";
    });
    let oAllTermsRegex = new RegExp(sAllTermsRegex, "g");

    //search logic
    let aSearchResult = [];
    let aAllDocs = await this.getDataFromDbByColNameAndFindQuery('textDocuments', {});

    aAllDocs.forEach(oElement => {
      let sDocName = oElement.name;
      let oDocData = oElement.data;
      let aOriginalDocData = oDocData.originalData;
      let aProcessedDocData = oDocData.processedData;

      let iCount = 0;
      let sLine = "";
      aProcessedDocData.forEach(function (sLineData, iIndex) {
        let aTempWhile = null;
        while ((aTempWhile = oAllTermsRegex.exec(sLineData)) !== null) {
          if (iCount === 0) {
            sLine = aOriginalDocData[iIndex] + "\n";
          }
          iCount++;
        }
      });

      if (iCount) {
        aSearchResult.push(new Result(sDocName, iCount, sLine));
      }
    });


    //sort searched result
    aSearchResult.sort(compareResults);

    return aSearchResult;
  }

  /** Given a text string, return a ordered list of all completions of
   *  the last normalized word in text.  Returns [] if the last char
   *  in text is not alphabetic.
   */
  async complete(text) {
    let oRegEx = new RegExp(".*[^a-zA-Z]$");
    if (oRegEx.test(text)) {
      return [];
    }

    let aAllInputWords = text.split(/\s+/);
    let sActualText = aAllInputWords[aAllInputWords.length - 1];

    let aResults = [];
    let aAllDocs = await this.getDataFromDbByColNameAndFindQuery('textDocuments', {});
    let oRegex = new RegExp(`\\b${sActualText}\\w*\\b`, 'g');

    aAllDocs.forEach(function (oElement) {
      let sLineData = oElement.data.originalDocument;
      let aFoundStrings = sLineData.match(oRegex);
      if (aFoundStrings && aFoundStrings.length) {
        aResults = aResults.concat(aFoundStrings)
      }
    });

    return [...new Set(aResults)].sort();
  }

  /**
   *
   * @param sCollName
   * @param oFindQuery
   * @returns {Promise<void>}
   */
  async getDataFromDbByColNameAndFindQuery(sCollName, oFindQuery) {
    let aData = [];
    try {
      aData = await this.myDb.collection(sCollName).find(oFindQuery).toArray();
    } catch (e) {
      throw e;
    }
    return aData;
  }

}

module.exports = DocFinder;



