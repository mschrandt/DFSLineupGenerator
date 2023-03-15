import './App.css';
import React, { useState } from 'react';
import Papa from "papaparse";
import GLPK from 'glpk.js';
import { Circles} from 'react-loader-spinner';
const seedrandom = require('seedrandom');
seedrandom('hello.', {global: true});
const async = require("async");
const RATE_LIMIT = 20;
const FPPG_COL = 5;
const PROXY_URL = "https://corsproxy.io/?";
const ROTOWIRE_URL = "https://www.rotowire.com/daily/tables/optimizer-nba.php?siteID=2&slateID=13281&projSource=RotoWire";
const rotowireData = {};
const positionOrder = {
  "PG" : 1,
  "SG" : 2,
  "SF" : 3,
  "PF" : 4,
  "C" : 5
}

fetch(PROXY_URL+ROTOWIRE_URL
).then(res=> {
    return res.json();
  }).then(res=> {
    res.forEach(element => {
      rotowireData[element.lineup_export_id] = element
    });

    console.debug(rotowireData);
  })

function playerFilter(excludeList = []) {
  return (player) => player.FPPG !== '' 
  && !excludeList.includes(player.Id) 
  && player['Injury Indicator'] != 'O';
}

function expandPlayerByPos(playerData) {
  return playerData.flatMap(player => player.Position.split('/')
    .map(position => {
      const p = { ...player }
      p.Position = position;
      return p;
    }))
    .map(player => {
      player.Id = player.Id + "_" + player.Position;
      return player
    });
}

function buildPlayerIds(playerData) {
  return playerData
    .map((player) =>
      player.Id
    );
}

function buildPointVars(playerData) {
  return playerData
    .map((player) => {
      return {
        name: player.Id,
        coef: parseFloat(player.FPPG)
      }
    });
}

function buildCostVars(playerData) {
  return playerData
    .map((player) => {
      return {
        name: player.Id,
        coef: parseInt(player.Salary)
      }
    });
}

function buildPositionVars(playerData, position) {
  return playerData
    .filter((player) => player.Position.includes(position))
    .map((player) => {
      return {
        name: player.Id,
        coef: 1
      }
    });
}

function buildTotalPlayers(playerData) {
  return playerData
    .map((player) => {
      return {
        name: player.Id,
        coef: 1
      }
    });
}

function buildLockedPlayersSubjectTo(lockedPlayers, unexpandedPlayerData, glpk) {
  return unexpandedPlayerData.filter(player => lockedPlayers.includes(player.Id))
    .map(player => {
      return {
        name: player.Id + " Locked",
        vars: player.Position.split('/').map(position => {
          return {
            name: player.Id + '_' + position,
            coef: 1
          }
        }),
        bnds: { type: glpk.GLP_FX, lb: 1, ub: 1 }
      }
    })
}

function buildDuplicatePlayerSubjectTo(unexpandedPlayerData, glpk) {
  return unexpandedPlayerData.filter(player => player.Position.includes('/'))
    .map(player => {
      return {
        name: player.Id + " Duplicate",
        vars: player.Position.split('/').map(position => {
          return {
            name: player.Id + '_' + position,
            coef: 1
          }
        }),
        bnds: { type: glpk.GLP_UP, ub: 1 }
      }
    })
}

function glpkLinearEquation(glpk,
  playerIds,
  pointVars,
  costVars,
  centerVars,
  sfVars,
  sgVars,
  pfVars,
  pgVars,
  totalPlayersVars,
  lockedPlayers,
  unexpandedPlayerData) {
  return {
    name: 'LP',
    objective: {
      direction: glpk.GLP_MAX,
      name: 'obj',
      /* x1: whether play 1 is included (0 if excluded)
        coef: expected score */
      vars:
        pointVars
    },
    subjectTo: [
      {
        name: 'C',
        vars: centerVars,
        bnds: { type: glpk.GLP_LO, lb: 1 }
      },
      {
        name: 'SG',
        vars: sgVars,
        bnds: { type: glpk.GLP_LO, lb: 2 }
      },
      {
        name: 'SF',
        vars: sfVars,
        bnds: { type: glpk.GLP_LO, lb: 2 }
      },
      {
        name: 'PG',
        vars: pgVars,
        bnds: { type: glpk.GLP_LO, lb: 2 }
      },
      {
        name: 'PF',
        vars: pfVars,
        bnds: { type: glpk.GLP_LO, lb: 2 }
      },
      {
        name: 'cost',
        vars: costVars,
        bnds: { type: glpk.GLP_UP, ub: 60000 }
      },
      {
        name: 'totalPlayers',
        vars: totalPlayersVars,
        bnds: { type: glpk.GLP_FX, lb: 9, ub: 9 }

      },
      ...buildLockedPlayersSubjectTo(lockedPlayers, unexpandedPlayerData, glpk),
      ...buildDuplicatePlayerSubjectTo(unexpandedPlayerData, glpk)
    ],
    binaries: playerIds
  }
}

function solve(glpk,
  playerIds,
  pointVars,
  costVars,
  centerVars,
  sfVars,
  sgVars,
  pfVars,
  pgVars,
  totalPlayersVars,
  lockedPlayers,
  unexpandedPlayerData) {

  const options = {
    msglev: glpk.GLP_MSG_OFF,
    presol: true,
    cb: {
      call: progress => console.log(progress),
      each: 1
    }
  };
  const equation = glpkLinearEquation(glpk,
    playerIds,
    pointVars,
    costVars,
    centerVars,
    sfVars,
    sgVars,
    pfVars,
    pgVars,
    totalPlayersVars,
    lockedPlayers,
    unexpandedPlayerData)
  return glpk.solve(equation, options);
}

async function generateSolutions(numLineups, lockedPlayers, removedPlayers, playerData, playerArray, setLpRes, setLoading, minUniqueness) {
  const glpk = await GLPK();
  const solutions = []
  var filteredPlayers = playerData.filter(playerFilter(removedPlayers));
  var expandedPalyers = expandPlayerByPos(filteredPlayers);
  var res = await solve(glpk,
    buildPlayerIds(expandedPalyers),
    buildPointVars(expandedPalyers),
    buildCostVars(expandedPalyers),
    buildPositionVars(expandedPalyers, "C"),
    buildPositionVars(expandedPalyers, "SF"),
    buildPositionVars(expandedPalyers, "SG"),
    buildPositionVars(expandedPalyers, "PF"),
    buildPositionVars(expandedPalyers, "PG"),
    buildTotalPlayers(expandedPalyers),
    lockedPlayers,
    filteredPlayers)

  const bestLineup = Object.entries(res.result.vars).filter(res => res[1] === 1)
    .map(res => res[0].split('_')[0])
  solutions.push(

    {
      score: res.result.z,
      lineup: formatSolution(Object.entries(res.result.vars).filter(res => res[1] === 1)
        .map(res => playerArray.find(element => element[0] === res[0].split('_')[0]).concat(res[0].split('_')[1])))
    })
  if (numLineups == 1) {
    setLpRes(solutions);
    setLoading(false);
  }

  //generate combinations
  const excludeLists = shuffleArray(combinations(bestLineup, minUniqueness)
    .filter((excludeList) => {
      for(var lockedPlayer of lockedPlayers){
        if(excludeList.includes(lockedPlayer)) return false;
      }
      return true;
    }))
    .slice(0, numLineups*2)
  var queue = async.queue(async (excludeList, callback) => {
    filteredPlayers = playerData.filter(playerFilter(removedPlayers.concat(excludeList)));
    expandedPalyers = expandPlayerByPos(filteredPlayers);
    await solve(glpk,
      buildPlayerIds(expandedPalyers),
      buildPointVars(expandedPalyers),
      buildCostVars(expandedPalyers),
      buildPositionVars(expandedPalyers, "C"),
      buildPositionVars(expandedPalyers, "SF"),
      buildPositionVars(expandedPalyers, "SG"),
      buildPositionVars(expandedPalyers, "PF"),
      buildPositionVars(expandedPalyers, "PG"),
      buildTotalPlayers(expandedPalyers),
      lockedPlayers,
      filteredPlayers).then((res) => {
        if (res.result.status === glpk.GLP_OPT) {
          solutions.push(
            {
              score: res.result.z,
              lineup: formatSolution(Object.entries(res.result.vars).filter(res => res[1] === 1)
                .map(res => playerArray.find(element => element[0] === res[0].split('_')[0]).concat(res[0].split('_')[1])))
            })
        }
      })
    callback();
  }, RATE_LIMIT);

  queue.drain(function() {
    var uniqueSolutions = unique(solutions).slice(0,numLineups);
    uniqueSolutions.sort((a,b)=>b.score-a.score);
    setLpRes(uniqueSolutions);
    setLoading(false); 
  })
  queue.push(excludeLists);
}

function combinations(lineup, minUniqueness = 1) {
  var combinationList = [];
  
  if(minUniqueness <= 1)
  {
    combinationList = combinationList.concat(lineup.map(v => [v]))
  }

  if(minUniqueness <= 2)
  {
    combinationList = combinationList.concat(
      lineup.flatMap(
        (v, i) => lineup.slice(i + 1).map(w => [v, w])
      ))
  }

  if(minUniqueness <= 3)
  {
    combinationList = combinationList.concat(
      lineup.flatMap(
        (v, i) => lineup.slice(i + 1).flatMap((w, j) =>
          lineup.slice(i + j + 2).map(x => [v, w, x]))
      )
    )
  }

  if(minUniqueness <= 4)
  {
    combinationList = combinationList.concat(
      lineup.flatMap(
        (v, i) => lineup.slice(i + 1).flatMap((w, j) =>
          lineup.slice(i + j + 2).flatMap((x, k) =>
            lineup.slice(i + j + k + 3).map(y => [v, w, x, y]))
        )
      )
    )
  }
    
  if(minUniqueness <= 5)
  {    
    combinationList = combinationList.concat(
      lineup.flatMap(
        (v, i) => lineup.slice(i + 1).flatMap((w, j) =>
          lineup.slice(i + j + 2).flatMap((x, k) =>
            lineup.slice(i + j + k + 3).flatMap((y, l) => 
            lineup.slice(i+j+k+l+4).map(z => [v, w, x, y, z])))
        )
      )
    )
  }

  return combinationList;
}

function shuffleArray(array) {
  for (let i = array.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [array[i], array[j]] = [array[j], array[i]];
  }

  return array;
}

function formatSolution(lineup) {
  return lineup.sort((a, b) => {
    const positionDiff = positionOrder[a[a.length - 1]]-positionOrder[b[b.length - 1]]
    if (positionDiff === 0) {
      return a[0].localeCompare(b[0])
    }
    return positionDiff
  })
}

function unique(array){
  var stringArray = array.map(JSON.stringify);
  var uniqueStringArray = new Set(stringArray);
  return Array.from(uniqueStringArray, JSON.parse);

}

function exportData(solutions){
  if(solutions.length < 1) return;
  var csvContent = "data:text/csv;charset=utf-8,";
  /* write header */
  csvContent += solutions[0].lineup.map(player=>player[player.length-1]).join(",") + "\r\n"
  
  /* write solutions */
  for(var solution of solutions){
    csvContent +=  solution.lineup.map(player=>player[0]+":"+player[3]).join(",") + "\r\n"
  }

  var encodedUri = encodeURI(csvContent);
  var link = document.createElement("a");
  link.setAttribute("href", encodedUri);
  link.setAttribute("download", "fanduel_lineup_" + new Date().toISOString() + ".csv");
  document.body.appendChild(link); // Required for FF

  link.click();
}

function PlayerList({ parsedData, setParsedData, tableRows, setTableRows, values, setValues, lockedPlayers, setLockedPlayers, removedPlayers, setRemovedPlayers }) {

  const changeHandler = (event) => {
    // Passing file data (event.target.files[0]) to parse using Papa.parse
    Papa.parse(event.target.files[0], {
      header: true,
      skipEmptyLines: true,
      complete: function (results) {
        const rowsArray = [];
        const valuesArray = [];

        results.data.forEach(element => {
          var playerId = element.Id.split("-")[1];
          if(rotowireData[playerId]){
            element.FPPG = rotowireData[playerId].proj_points;
          }else if(element['Injury Indicator'] === 'O'){
            element.FPPG = 0;
          }else {
            element.FPPG = 0;
          }
        });

        results.data.sort((a,b) => b.FPPG - a.FPPG)

        // Iterating data to get column name and their values
        results.data.map((d) => {
          rowsArray.push(Object.keys(d));
          valuesArray.push(Object.values(d));
        });

        // Parsed Data Response in array format
        setParsedData(results.data);

        // Filtered Column Names
        setTableRows(rowsArray[0]);

        // Filtered Values
        setValues(valuesArray);
      },
    });
  };

  const lockPlayer = (event, playerId) => {
    if (event.target.checked) {
      lockedPlayers.push(playerId);
    } else {
      var indexToRemove = lockedPlayers.indexOf(playerId);
      if (indexToRemove > -1) {
        lockedPlayers.splice(indexToRemove, 1);
      }
    }

    setLockedPlayers(lockedPlayers);
  }

  const removePlayer = (event, playerId) => {
    if (event.target.checked) {
      removedPlayers.push(playerId);
    } else {
      var indexToRemove = removedPlayers.indexOf(playerId);
      if (indexToRemove > -1) {
        removedPlayers.splice(indexToRemove, 1);
      }
    }

    setRemovedPlayers(removedPlayers);
  }

  const changeFppg = (event, playerId) => {
    const indexToUpdate = values.findIndex((player) => player[0]===playerId);
    if(event.target.value >= event.target.min &&
        event.target.value <= event.target.max){
          values[indexToUpdate][FPPG_COL] = event.target.value;
          setValues(values);
          parsedData[indexToUpdate].FPPG = event.target.value;
          setParsedData(parsedData);
        }
  }

  return (
    <div className='playerList'>
      <h2>Upload Fanduel Player List (.csv)</h2>
      {/* File Uploader */}
      <input
        type="file"
        name="file"
        onChange={changeHandler}
        accept=".csv"
      />
      <br />
      <br />
      {/* Table */}
      <table>
        <thead>
          <tr>
            {
              tableRows.map((rows, index) => {
                return <th key={index}>{rows}</th>;
              })
            }
            {values.length > 0 && <th key="lock">Lock Player</th>}
            {values.length > 0 && <th key="remove">Remove Player</th>}

          </tr>
        </thead>
        <tbody>
          {values.map((value, index) => {
            return (
              <tr key={index}>
                {value.map((val, i) => {
                  if(i === 5){
                    //fppg override
                    return <td key={i}><input type="number" defaultValue={val} min="0" max="100" onChange={(event) => changeFppg(event, value[0])}></input></td>
                  }else{
                    return <td key={i}>{val}</td>;
                  }
                })}
                <td key="lock"><input type="checkbox" onChange={(event) => lockPlayer(event, value[0])} ></input></td>
                <td key="remove"><input type="checkbox" onChange={(event) => removePlayer(event, value[0])} ></input></td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Lineups({ lockedPlayers, removedPlayers, parsedData, values, lpRes, setLpRes }) {

  const [numLineups, setNumLineups] = useState(10);
  const [loading, setLoading] = useState(false);
  const [minUniqueness, setMinUniqueness] = useState(1);
  const generateLineupsButtonEvent = () => {
    setLpRes([])
    setLoading(true)
    generateSolutions(numLineups, lockedPlayers, removedPlayers, parsedData, values, setLpRes, setLoading, minUniqueness);
  }

  const header = ["Row", "PG", "PG", "SG", "SG","SF", "SF","PF", "PF", "C", "Salary","Score"]

  return <div className="lineups">
    <h2>Generate Lineups</h2>
    <label>Number of Lineups:</label>
    <input type="number"
      id="numLineups"
      name="numLineups"
      min="1"
      max="250"
      defaultValue={numLineups}
      onChange={(event) => setNumLineups(event.target.value)} />
    <br />
    <label>Minimum unique players per lineup: {minUniqueness}</label>
    <input type="range" 
      min="1" 
      max="5" 
      value={minUniqueness} 
      onChange={(event) => setMinUniqueness(event.target.value)}
      />
    
    <br />
    <button type="button" onClick={generateLineupsButtonEvent} disabled={loading}>Generate Lineups</button>
    <button type="button" onClick={()=>exportData(lpRes)} hidden={lpRes.length<=0}>Export Lineups</button>
    <Circles height="40"
      width="40"
      color="#4fa94d"
      ariaLabel="circles-loading"
      wrapperStyle={{}}
      wrapperClass=""
      visible={loading}/>
    <table>
      <thead>
        <tr>
          {lpRes.length > 0 &&
            header.map((rows, index) => {
              return <th key={index}>{rows}</th>;
            })
          }
        </tr>
      </thead>
      <tbody>
        {lpRes.map((value, index) => {
          return (
            <tr key={index}>
              {<td key="row">{index+1}</td>}
              {
                value.lineup.map((val, i) => {
                  return <td key={i}>{val[3]}</td>
                })
              }
              {<td key="salary">{value.lineup.reduce((prev, cur) => prev + parseInt(cur[7]), 0)}</td>}
              {<td key="score">{Math.round(value.score*100)/100}</td>}
            </tr>
          )
        })}
      </tbody>
    </table>
  </div>
}

function App() {


  // State to store parsed data
  const [parsedData, setParsedData] = useState([]);

  //State to store table Column name
  const [tableRows, setTableRows] = useState([]);

  //State to store the values
  const [values, setValues] = useState([]);

  //State to store the values
  const [lpRes, setLpRes] = useState([]);

  const [lockedPlayers, setLockedPlayers] = useState([]);
  const [removedPlayers, setRemovedPlayers] = useState([]);

  return <div className="main">
    <PlayerList 
      parsedData={parsedData}
      setParsedData={setParsedData}
      tableRows={tableRows}
      setTableRows={setTableRows}
      values={values}
      setValues={setValues}
      lockedPlayers={lockedPlayers}
      setLockedPlayers={setLockedPlayers}
      removedPlayers={removedPlayers}
      setRemovedPlayers={setRemovedPlayers} />

    <Lineups lockedPlayers={lockedPlayers}
      removedPlayers={removedPlayers}
      parsedData={parsedData}
      values={values}
      lpRes={lpRes}
      setLpRes={setLpRes} />
  </div>
}

export default App;
