#!/usr/bin/env node
/* eslint-disable camelcase, no-multiple-empty-lines */

/*
mp3splitter-js
Version: 1.4.0
Author: Gilles Bouthenot
https://github.com/gbouthenot/mp3splitter-js

ID3:
  - http://id3.org/id3v2.4.0-frames
  - http://id3.org/d3v2.3.0
  - http://id3.org/id3v2-chapters-1.0
VBR header:
  - https://www.codeproject.com/Articles/8295/MPEG-Audio-Frame-Header
  - http://gabriel.mp3-tech.org/mp3infotag.html
*/

const fs = require('fs')

class Cliapp {
  constructor (argv) {
    this.argv = argv
  }

  go () {
    if (this.argv[2] === undefined) {
      console.log(`Usage: node ${this.argv[1]} filetosplit.mp3`)
      process.exit(1)
    }

    const fname = this.argv[2]
    const fileread = new Filereader(fname)

    const mp3splitter = new Mp3splitter(fileread)
    mp3splitter.go()
  }
}


class Filereader {
  constructor (fname) {
    this.fd = fs.openSync(fname, 'r') // throw error if file does not exist

    this.fBufPos = 0
    this.fBufAvail = 0
    this.fBufFilePos = 0
    this.fFilePos = 0
    this.fBuf = new Uint8Array(10 * 1024 * 1024)
  }

  /**
   * advance to next byte and read
   * @return int or false
   */
  getNextByte () {
    if (this.fBufAvail === 0) {
      this.fBufPos = 0
      const read = fs.readSync(this.fd, this.fBuf, this.fBufPos, this.fBuf.length)
      this.fBufAvail = read
      this.fBufFilePos = this.fFilePos
      this.fFilePos += read
    }
    if (this.fBufAvail === 0) {
      return false
    }
    this.fBufAvail--
    return this.fBuf[this.fBufPos++]
  }

  getBytes (n) {
    if (this.fBufAvail < (n - 1)) {
      // console.log('XXX')
      // console.log('n', n)
      // console.log('bufAvail', this.fBufAvail)
      // console.log('bufFilePos', this.fBufFilePos)
      // console.log('bufPos', this.fBufPos)

      this.fBuf = this.fBuf.copyWithin(0, this.fBufPos - 1)
      this.fBufFilePos += this.fBufPos - 1
      this.fBufPos = 1
      const read = fs.readSync(this.fd, this.fBuf, this.fBufAvail + 1, this.fBuf.length - this.fBufAvail - 1)
      this.fBufAvail += read
      this.fFilePos += read
      // console.log('YYY')
      // console.log('bufAvail', this.fBufAvail)
      // console.log('bufFilePos', this.fBufFilePos)
      // console.log('bufPos', this.fBufPos)

      if (this.fBufAvail < (n - 1)) {
        console.warn('Reached end of file !')
        this.fBufAvail = 0
        return this.fBuf.slice(this.fBufPos - 1, this.fBufPos + n - 1)
      }
    }
    const retbuf = this.fBuf.slice(this.fBufPos - 1, this.fBufPos + n - 1)
    this.fBufPos += n - 1
    this.fBufAvail -= n - 1
    return retbuf
  }

  rewind (n) {
    this.fBufAvail += n - 1
    this.fBufPos -= n - 1
  }
}


class Id3v2 {
  /**
   * return int or false if not a synchsafe integer
   */
  readSyncsafeInt32 (buf) {
    if (((buf[0] | buf[1] | buf[2] | buf[3]) & 0x80) !== 0) {
      // not a 32 bit synchsafe integer
      return false
    }

    let size = (buf[0] & 0x7f) << 21
    size += (buf[1] & 0x7f) << 14
    size += (buf[2] & 0x7f) << 7
    size += (buf[3] & 0x7f)

    return size
  }

  readInt32 (buf) {
    let size = buf[0] << 24
    size += buf[1] << 16
    size += buf[2] << 8
    size += buf[3]
    return size
  }

  /**
   * read a unsynched int32 and convert the buffer to synchsafe Int32
   * return int, MODIFY buf
   */
  convertInt32toSyncsafe (buf) {
    const len = this.readInt32(buf)
    buf[0] = (len & 0xfe00000) >> 21
    buf[1] = (len & 0x1fc000) >> 14
    buf[2] = (len & 0x3f80) >> 7
    buf[3] = len & 0x7f
    return len
  }

  /**
   * Check if buf is a correct Id3v2 header
   * @return false or Object header
   */
  checkHeader (buf) {
    let b0, b1
    const fullheader = {
      raw: buf,
      parsed: {
        versionStr: null,
        versionMaj: null,
        size: null,
        totalsize: null,
        flags: {
          unsynch: null,
          extended: null,
          experimental: null,
          footer: null
        }
      }
    }
    const header = fullheader.parsed

    if (buf[0] !== 73 || buf[1] !== 68 || buf[2] !== 51) {
      return false
    }
    // version
    b0 = buf[3]
    b1 = buf[4]
    if (b0 === 255 || b1 === 255) {
      return false
    }
    header.versionStr = `ID3v2.${String.fromCharCode(b0 + 48)}.${String.fromCharCode(b1 + 48)}`
    header.versionMaj = b0

    if (b0 !== 3 && b0 !== 4) {
      console.warn('Only support ID3v2.3 and ID3v2.4', header.versionStr)
      return false
    }

    // abcd0000
    b0 = buf[5]
    if (b0 & 0x0f !== 0) {
      // no 0000
      return false
    }
    header.flags.unsynch = (b0 & 0x80) !== 0
    header.flags.extended = (b0 & 0x40) !== 0
    header.flags.experimental = (b0 & 0x20) !== 0
    header.flags.footer = (b0 & 0x10) !== 0

    header.size = this.readSyncsafeInt32(buf.slice(6, 10))
    if (header.size === false) {
      return false
    }

    header.totalsize = header.size + 10 + header.flags.footer * 10

    return fullheader
  }

  /**
  * Frame:
  * Frame ID      $xx xx xx xx  (four characters)
  * Size      4 * %0xxxxxxx
  * Flags         %0abc0000 %0h00kmnp
  */
  readFrameHeader (buf, tagheader) {
    let header = {
      raw: buf,
      id: null,
      size: null,
      totalsize: null,
      flags: {
        tagAlterPreservation: null,
        fileAlterPreservation: null,
        readOnly: null,
        groupingIdentity: null,
        compression: null,
        encryption: null,
        unsynchronisation: null,
        dataLengthIndicator: null
      }
    }
    let [b0, b1, b2, b3] = [buf[0], buf[1], buf[2], buf[3]]
    if (!((b0 >= 48 && b0 <= 57) || (b0 >= 65 && b0 <= 90))) { return false }
    if (!((b1 >= 48 && b1 <= 57) || (b1 >= 65 && b1 <= 90))) { return false }
    if (!((b2 >= 48 && b2 <= 57) || (b2 >= 65 && b2 <= 90))) { return false }
    if (!((b3 >= 48 && b3 <= 57) || (b3 >= 65 && b3 <= 90))) { return false }

    header.id = String.fromCharCode(b0, b1, b2, b3)

    if (tagheader.parsed.versionMaj === 3) {
      // id3v2.3 to id3v2.4
      header.size = this.convertInt32toSyncsafe(buf.subarray(4, 8)) // must use subarray
    } else {
      header.size = this.readSyncsafeInt32(buf.slice(4, 8))
      if (header.size === false) {
        return false
      }
    }

    header.totalsize = header.size + 10;

    // flags
    [b0, b1] = [buf[8], buf[9]]
    header.flags.tagAlterPreservation = (b0 & 0x40) !== 0
    header.flags.fileAlterPreservation = (b0 & 0x20) !== 0
    header.flags.readOnly = (b0 & 0x10) !== 0
    header.flags.groupingIdentity = (b1 & 0x40) !== 0
    header.flags.compression = (b1 & 0x08) !== 0
    header.flags.encryption = (b1 & 0x04) !== 0
    header.flags.unsynchronisation = (b1 & 0x02) !== 0
    header.flags.dataLengthIndicator = (b1 & 0x01) !== 0

    return header
  }

  /**
   * Read null-terminated string
   * Handle there encodings:
   * ISO-8859-1
   * UTF-16 with/without BOM (if BOM is not present, assume Big Endian)
   * UTF-8
   * return { str: string, offset: off }
   */
  readEncodedString (enc, buf, off) {
    let c
    let str = ''
    let littleEndian = false
    if (enc === 0) {
      for (; off < buf.length; off++) {
        c = buf[off]
        if (c === 0) {
          off++
          break
        }
        str += String.fromCharCode(c)
      }
    } else if (enc === 1 || enc === 2) {
      for (; off < buf.length; off += 2) {
        if (littleEndian) {
          c = (buf[off + 1] << 8) + buf[off]
        } else {
          c = (buf[off] << 8) + buf[off + 1]
        }
        if (c === 0) {
          off += 2
          break
        } else if (c === 65279) {
          // BOM: good !
        } else if (c === 65534) {
          // BOM change LE <-> BE
          littleEndian = !littleEndian
        } else {
          str += String.fromCharCode(c)
        }
      }
    } else if (enc === 3) {
      const part = buf.slice(off)
      const idx = part.indexOf(0)
      str = Buffer.from(part.slice(0, idx)).toString('utf8')
      off += idx + 1
    } else {
      console.warn(`Bad encoding ${enc}, off=${off}, buf=`, buf)
    }
    return { str, offset: off }
  }



  /**
   * Parse frame according to header
   * return Object frame
   */
  readFrameData (header, buf, tagheader) {
    const frame = { header, data: { parsed: null, raw: buf } }
    const id = header.id
    let data
    let parsed
    if (id === 'APIC') {
      parsed = `(${buf.length} bytes)`
    } else if (id === 'CHAP') {
      parsed = this.readTagCHAP(buf, tagheader)
    } else if (id === 'TXXX') {
      const encoding = buf[0]
      data = this.readEncodedString(encoding, buf, 1)
      parsed = [data.str, this.readEncodedString(encoding, buf, data.offset).str]
    } else if (id[0] === 'T') {
      const encoding = buf[0]
      parsed = this.readEncodedString(encoding, buf, 1).str
    } else {
      // TODO Handle other frames
      // console.log(`TAG: ${id}`, buf.reduce((a, b) => b >= 32 && b <= 127 ? a + String.fromCharCode(b) : `${a}%${b.toString(16)} `, ''))
      // console.log('raw:', buf.reduce((a, b) => `${a}%${b.toString(16)} `, ''))
    }
    frame.data.parsed = parsed
    return frame
  }

  readTagCHAP (buf, tagheader) {
    const data = {
      id: null,
      startTime: null,
      endTime: null,
      subFrames: []
    }
    const retstr = this.readEncodedString(0, buf, 0);
    [data.id, buf] = [retstr.str, buf.slice(retstr.offset)]
    data.startTime = this.readInt32(buf)
    data.endTime = this.readInt32(buf.slice(4))
    buf = buf.slice(16)
    while (buf.length > 10) {
      const sfheader = this.readFrameHeader(buf, tagheader)
      const sfdata = buf.slice(10, sfheader.size + 10)
      data.subFrames.push({ id: sfheader.id, data: this.readFrameData(sfheader, sfdata, tagheader).data.parsed })
      buf = buf.slice(sfheader.size + 10)
    }
    return data
  }

  renderFrame (id, str) {
    const len = str.length + 2 // encoding, string, ending
    const header = [
      id.charCodeAt(0), id.charCodeAt(1), id.charCodeAt(2), id.charCodeAt(3),
      (len & 0xfe00000) >> 21, (len & 0x1fc000) >> 14, (len & 0x3f80) >> 7, len & 0x7f,
      0, 0 // flags
    ]
    const data = [ 0 ] // encoding
    str.split('').forEach(c => {
      data.push(c.charCodeAt())
    })
    data.push(0)

    return { header: { raw: new Uint8Array(header) }, data: { raw: new Uint8Array(data) } }
  }

  renderTag (frames) {
    // render frames
    const rawframes = frames.reduce((buf, frame) => {
      // append raw header and raw data to existing raw
      const b = new Uint8Array(buf.length + frame.header.raw.length + frame.data.raw.length)
      b.set(buf, 0)
      b.set(frame.header.raw, buf.length)
      b.set(frame.data.raw, buf.length + frame.header.raw.length)
      return b
    }, new Uint8Array(0))

    const len = rawframes.length
    const raw = new Uint8Array(10 + len)
    const head = [73, 68, 51, 4] // header ID3v2.4, all flags cleared
    raw.set(head, 0)
    raw[6] = (len & 0xfe00000) >> 21
    raw[7] = (len & 0x1fc000) >> 14
    raw[8] = (len & 0x3f80) >> 7
    raw[9] = len & 0x7f
    raw.set(rawframes, 10)
    return raw
  }
}


class Mp3 {
  getHeader (buf) {
    let b, v, bb, cc

    const header = { raw: buf }
    if (buf[0] !== 0xff) {
      return false
    }

    // AAABBCCD
    b = buf[1]

    // AAA
    if ((b & 0xe0) !== 0xe0) {
      // console.log('AAA is not 111')
      return false
    }

    // BB: MPEG VERSION
    bb = (b & 0x18) >> 3
    if (bb === 1) {
      // console.log('mpeg version reserved')
      return false
    }
    header.mpegVersion = ['2.5', '(reserved)', '2', '1'][bb]
    // console.log(`bb=${bb}: mpeg version ${header.mpegVersion}`)

    // CC: LAYER
    cc = (b & 6) >> 1
    if (cc === 0) {
      // console.log('layer reserved')
      return false
    }
    header.layer = ['(reserved)', 'III', 'II', 'I'][cc]
    // console.log(`cc=${cc}: Layer ${header.layer}`)

    header.samplesPerFrame = [[ // mpeg2.5
      // 0, layer3, layer2, layer 1
    ], [ // reserved
    ], [ // mpeg2
      0, 576, 1152, 384
    ], [ // mpeg1
      0, 1152, 1152, 384
    ]][bb][cc]
    // console.log(`samples per frame=${header.samplesPerFrame}`)

    // D
    header.hasCRC = (b & 1) === 0
    // console.log(`hasCRC: ${header.hasCRC}`)

    // EEEEFFGH
    b = buf[2]

    // EEEE
    v = (b & 0xf0) >> 4
    const bitratesTb = [
      [ 0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448, 1 ],
      [ 0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384, 1 ],
      [ 0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 1 ],
      [ 0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256, 1 ],
      [ 0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 1 ]
    ]
    header.bitrate = bitratesTb[[2, 1, 0, 4, 4, 3][(bb < 3) * 3 + cc - 1]][v]
    // console.log(`eeee: ${v}, bb=${bb}, cc=${cc}: bitrate=${header.bitrate}`)

    // FF
    v = (b & 0xc) >> 4
    if (v === 3) {
      console.log(`ff=${v}, Sampling rate reserved`)
      return false
    }
    const srtb = [[11025, 12000, 8000], [0, 0, 0], [22050, 24000, 16000], [44100, 48000, 32000]]
    header.sampleRate = srtb[bb][v]
    // console.log(`ff=${v}: sample rate=${header.sampleRate}`)

    // G
    header.isPadded = (b & 2) !== 0
    // console.log(`isPadded: ${header.isPadded}`)

    header.frameSize = Math.floor(header.samplesPerFrame * 125 * header.bitrate / header.sampleRate) + header.isPadded
    // console.log(`frameSize=${header.frameSize}`)

    // H (private bit, not used)

    // IIJJKLMM
    b = buf[3]

    // II: mono/stereo
    v = (b & 0xc0) >> 10
    header.channelMode = ['Stereo', 'Joint stereo', 'Dual channel', 'Single channel'][v]
    header.xingOffset = [[17, 17, 17, 9], [], [17, 17, 17, 9], [32, 32, 32, 17]][bb][v]
    // console.log(`ii=${v}: channelMode=${header.channelMode} xingOffset=${header.xingOffset}`)

    // JJ Joint Stereo extension

    // K Copyright

    // L Original

    // MM: emphasis

    return header
  }

  isXing (header, frame) {
    const c1 = frame[header.xingOffset]
    if (c1 === 73 || c1 === 88) { // 'X' or 'I' (optimize)
      const str = String.fromCharCode.apply(0, frame.slice(header.xingOffset, header.xingOffset + 4))
      return str === 'Xing' || str === 'Info'
    }
    return false
  }
}


// class mp3buffer {
//   constructor () {
//     this.buf = new Uint8Array()
//   }

//   append (arr) {
//     let b
//     if (arr[0] && typeof arr[0].length !== 'undefined') {
//       // push array
//       let newlen = arr.reduce((len, elem) => len + elem.length, this.buf.length)
//       b = new Uint8Array(newlen)
//       b.set(this.buf, 0)
//       arr.reduce((acc, elem) => {
//         b.set(elem, acc)
//         return acc + elem.length
//       }, this.buf.length)
//     } else {
//       b = new Uint8Array(this.buf.length + arr.length)
//       b.set(this.buf, 0)
//       b.set(arr, this.buf.length)
//     }
//     this.buf = b
//     return b
//   }
// }

class Segment {
  constructor (num, chaps, id3frames, xing) {
    this.num = num // file number (start at 0)
    this.chaps = chaps // all chapters
    this.chap = chaps[num] // this chapter
    this.id3frames = id3frames // [first:[], next:[]] frames
    this.buf = []
    this.framesLen = []
    this.xing = xing // [mp3header, mp3data]
  }

  push (header, data) {
    this.buf.push(header.raw, data)
    this.framesLen.push(header.frameSize)
  }

  renderBuf () {
    let newlen = this.buf.reduce((len, elem) => len + elem.length, 0)
    const buf = new Uint8Array(newlen)
    this.buf.reduce((acc, elem) => {
      buf.set(elem, acc)
      return acc + elem.length
    }, 0)
    return buf
  }

  getFilename () {
    // filename
    const num = this.num + 1
    const tit2 = this.chap.subFrames.find(f => f.id === 'TIT2')
    const numpadded = `00${num}`.slice(-(Math.max(3, num.toString().length)))
    let fn = numpadded
    if (tit2) {
      fn += `-${tit2.data}`
    }
    fn += '.mp3'
    return fn
  }

  /**
   * Render the tag and push it to the buffer
   */
  prependTag () {
    const id3v2 = new Id3v2()

    let splFrames // frames for this split

    // clone the array because we are going to add frames
    if (this.num === 0) {
      splFrames = [ ...this.id3frames.first ]
    } else {
      splFrames = [ ...this.id3frames.next ]
    }

    // Add frames 'Tracknumber, 'TotalTracks', 'Track Title'
    splFrames.push(id3v2.renderFrame('TRCK', `${this.num + 1}/${this.chaps.length}`))
    const tit2 = this.chap.subFrames.find(f => f.id === 'TIT2')
    if (tit2) {
      splFrames.push(id3v2.renderFrame('TIT2', tit2.data))
    }

    // prepend tag to buffer
    const rawid3 = id3v2.renderTag(splFrames)
    this.buf.unshift(rawid3)
  }

  prependXing () {
    if (!this.xing) {
      // no xing frame
      return
    }
    const [header, frame] = this.xing
    const off = header.xingOffset

    const nbframes = this.framesLen.length
    const nbbytes = this.framesLen.reduce((acc, e) => acc + e, 0)

    const toc = this.getToc()
    const useToc = (toc.length === 100) && (header.frameSize >= (116 + header.xingOffset))
    // data will store, flags, nbFrames, nbBytes
    const data = [0, 0, 0, 3 + 4 * useToc]
    data.push((nbframes & 0xff000000) >> 24, (nbframes & 0xff0000) >> 16, (nbframes & 0xff00) >> 8, nbframes & 0xff)
    data.push((nbbytes & 0xff000000) >> 24, (nbbytes & 0xff0000) >> 16, (nbbytes & 0xff00) >> 8, nbbytes & 0xff)
    frame.set(data, off + 4)
    if (useToc) {
      frame.set(toc, off + 16)
    }

    // prepend Xing frame to buffer
    this.buf.unshift(frame)
    this.buf.unshift(header.raw)
  }

  getToc () {
    const nbframes = this.framesLen.length
    const nbbytes = this.framesLen.reduce((acc, e) => acc + e, 0)
    // console.log(nbframes.toString(16), nbbytes.toString(16))

    const toc = []
    let cursize = 0
    let nxt = 0
    this.framesLen.forEach((len, i) => {
      if (i >= nxt) {
        nxt += nbframes / 100
        toc.push(Math.floor(255 * cursize / nbbytes))
      }
      cursize += len
    })
    // toc.forEach(r => console.log(r.toString(16)))
    return toc
  }


  /**
   * Create a new file for writing
   * chap: use endtime and subframes
   */
  save () {
    const fn = this.getFilename()

    // 2nd data
    this.prependXing()

    // 1st data
    this.prependTag()

    // save new file
    console.log(`saving ${fn}`)
    const ofd = fs.openSync(fn, 'w')
    fs.writeSync(ofd, this.renderBuf())
    fs.closeSync(ofd)
  }
}


class Mp3splitter {
  constructor (fileread) {
    this.infile = fileread
    this.id3v2 = new Id3v2()
    this.mp3 = new Mp3()

    // out file
    this.onum = 0
  }

  go () {
    let b
    const chaps = []
    let chapidx = -1
    let cursample = 0
    let segLastSpl = -1
    let segment = null

    const id3frames = { first: [], next: [] }
    let xingFrame = null

    while ((b = this.infile.getNextByte()) !== false) {
      // const pos = this.fBufFilePos + this.fBufPos - 1
      // console.log(`testing byte=${b} at ${pos} (0x${pos.toString(16)})`)
      if (b === 73) {
        // Possible ID3V2 header
        // console.log(`possible ID3V2 frame header at ${pos} (0x${pos.toString(16)})`)
        let buf = this.infile.getBytes(10)
        const id3v2header = this.id3v2.checkHeader(buf)
        if (id3v2header) {
          // console.log('ID3V2 HEADER FOUND', id3v2header)

          if (id3v2header.parsed.flags.extended) {
            throw new Error('ID3v2 extended header is not supported')
          }
          let rSize = id3v2header.parsed.size // remaining size

          // read all frames
          while (rSize > 0) {
            b = this.infile.getNextByte()
            if (b === 0) {
              rSize--
              if (id3v2header.parsed.flags.footer) {
                throw new Error('There must be no padding when footer is present !')
              }
            } else {
              buf = this.infile.getBytes(10)
              rSize -= 10
              const frameHeader = this.id3v2.readFrameHeader(buf, id3v2header)
              if (!frameHeader) {
                console.error('Id3v2 frame header:', buf)
                throw new Error('frame header bad format')
              }
              // console.log('Frame header', frameHeader)

              this.infile.getNextByte()
              buf = this.infile.getBytes(frameHeader.size)
              rSize -= frameHeader.size
              const frame = this.id3v2.readFrameData(frameHeader, buf, id3v2header)
              // to show ID3 data, uncomment the following line
              // console.log(frame.header.id, frame.data.parsed)

              if (frameHeader.id === 'CHAP') {
                // not kept, but stored separately
                chaps.push(frame.data.parsed)
              } else if (frameHeader.id === 'APIC') {
                // kept only in first file
                id3frames.first.push(frame)
              } else if (!['TRCK', 'TIT2'].includes(frameHeader.id)) {
                // kept in all files
                id3frames.first.push(frame)
                id3frames.next.push(frame)
              }
            }
          }
        }
      } else if (b === 255) {
        // Possible MP3 frame header

        // const pos = this.fBufFilePos + this.fBufPos - 1
        // console.log(`possible mp3 frame header at ${pos} (0x${pos.toString(16)})`)

        const buf = this.infile.getBytes(4)
        // console.log('buf', buf)

        const mp3header = this.mp3.getHeader(buf)
        if (mp3header) {
          // console.log('MP3 HEADER FOUND', mp3header)
          this.infile.getNextByte()
          const mp3frame = this.infile.getBytes(mp3header.frameSize - 4)

          if (this.mp3.isXing(mp3header, mp3frame)) {
            if (!xingFrame) {
              // store only the first.
              xingFrame = [mp3header, mp3frame]
            }
            // Do not store this frame
            continue
          }

          if (cursample > segLastSpl) {
            if (chaps.length === 0) {
              throw new Error('No chapter information found in ID3V2 tag')
            } else if (chaps[++chapidx]) {
              // next chapter is present. Split.
              if (segment) {
                segment.save()
              }
              segment = new Segment(chapidx, chaps, id3frames, xingFrame)
              segLastSpl = chaps[chapidx].endTime * mp3header.sampleRate / 1000
            }
          }

          segment.push(mp3header, mp3frame)
          cursample += mp3header.samplesPerFrame
        } else {
          this.infile.rewind(4)
        }
      }
    }
    // EOF
    if (segment) {
      segment.save()
    }
  }
}

const cliapp = new Cliapp(process.argv)
cliapp.go()
